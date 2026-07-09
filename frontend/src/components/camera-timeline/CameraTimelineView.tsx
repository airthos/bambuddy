import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ImageDown, Loader2, Pause, Play, SkipBack, SkipForward, Star, Trash2 } from 'lucide-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { formatDuration, formatMediaTime, parseUTCDate } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import { api } from '../../api/client';
import type { CameraRecordingSummary, Printer } from '../../api/client';

// Sentry playback is an *image sequence*, not a video: the backend serves
// fixed-size chunks of half-res JPEGs (see camera_frame_pack.py) and the
// player buffers a bounded window near the playhead, decodes frames to
// ImageBitmaps, and draws them to a <canvas> on a timer. No codec, no
// MediaSource buffer -- so there is nothing that can stall "buffered but
// frozen" the way the old all-intra HLS pipeline did.

// Must match camera_frame_pack.CHUNK_FRAMES on the backend.
const CHUNK_FRAMES = 50;
// Bounded forward/back buffer, in chunks (~1.3MB each). Keeps memory + network
// bounded regardless of recording length; ~9 chunks ahead keeps 50x playback
// well supplied.
const AHEAD_CHUNKS = 9;
const BACK_CHUNKS = 2;
// Decoded-bitmap window within loaded chunks.
const BMP_AHEAD = 120;
const BMP_BACK = 20;
// Real-time playback reproduces the true seconds between frames, but capture
// has big idle gaps (printer offline / paused). Playing those out in real time
// looks like a dead freeze on one frame; cap the per-frame dwell so idle time
// is skipped fast instead of stalling.
const MAX_GAP_SECONDS = 4;
// Retries per chunk before giving up. A failed fetch must NEVER propagate into
// the playback clock (that was the original freeze) -- loadChunk resolves to
// null on give-up and the clock keeps ticking regardless.
const CHUNK_MAX_RETRIES = 6;

const SPEEDS = [
  { key: 'half', rate: 0.5 },
  { key: 'normal', rate: 1 },
  { key: 'double', rate: 2 },
  { key: 'fiveX', rate: 5 },
  { key: 'twentyX', rate: 20 },
  { key: 'fiftyX', rate: 50 },
  { key: 'hundredX', rate: 100 },
] as const;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface FrameMeta {
  seq: number;
  ts_ms: number;
}
interface ParsedChunk {
  buf: ArrayBuffer;
  offs: number[]; // byte offset of each frame's JPEG within buf
  lens: number[];
}

interface GapBlock {
  type: 'gap';
  start: number;
  end: number;
}
interface JobBlock {
  type: 'job';
  recording: CameraRecordingSummary;
  start: number;
  end: number;
}
type TimelineBlock = GapBlock | JobBlock;

// The backend sends naive UTC timestamps with no 'Z'/offset -- parseUTCDate is
// the app's standard fix (see utils/date.ts) so elapsed/duration readouts don't
// silently shift by the local UTC offset.
function recordingStart(r: CameraRecordingSummary): number {
  return parseUTCDate(r.started_at)?.getTime() ?? Date.now();
}
function recordingEnd(r: CameraRecordingSummary): number {
  if (r.stopped_at) return parseUTCDate(r.stopped_at)?.getTime() ?? Date.now();
  return Date.now(); // still recording
}

function buildTimeline(recordings: CameraRecordingSummary[]): TimelineBlock[] {
  const sorted = [...recordings].sort((a, b) => recordingStart(a) - recordingStart(b));
  const blocks: TimelineBlock[] = [];
  let cursor: number | null = null;
  for (const r of sorted) {
    const start = recordingStart(r);
    const end = recordingEnd(r);
    if (cursor !== null && start > cursor) {
      blocks.push({ type: 'gap', start: cursor, end: start });
    }
    blocks.push({ type: 'job', recording: r, start, end });
    cursor = end;
  }
  return blocks;
}

function jobClass(r: CameraRecordingSummary): string {
  if (r.status === 'recording') return 'bg-bambu-green text-white';
  if (r.archive_status === 'failed') return 'bg-red-900/80 text-red-200';
  if (r.archive_status === 'cancelled' || r.archive_status === 'aborted') return 'bg-yellow-700/80 text-yellow-100';
  if (r.status === 'orphaned') return 'bg-orange-800/80 text-orange-100';
  return 'bg-blue-600/70 text-white';
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 mb-1">
      <span className="text-bambu-gray">{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}

function parseChunk(buf: ArrayBuffer): ParsedChunk {
  const dv = new DataView(buf);
  const count = dv.getUint32(0);
  const offs: number[] = [];
  const lens: number[] = [];
  let off = 4 + 4 * count; // header = count + one uint32 length per frame
  for (let k = 0; k < count; k++) {
    const len = dv.getUint32(4 + 4 * k);
    offs.push(off);
    lens.push(len);
    off += len;
  }
  return { buf, offs, lens };
}

// A snapshot reduced to what the timeline needs: its id (for the image URL) and
// its capture time in ms. Interval snapshots are an ambient log captured for
// every active printer regardless of print state, so they exist during jobs and
// in the idle gaps between them -- which is exactly what fills the filmstrip.
interface SnapPoint {
  id: number;
  ms: number;
}

// Naive-UTC ISO (no 'Z'/offset) to match how the backend stores/compares
// captured_at; the 'since' query param is parsed as naive UTC there.
const toNaiveUtcIso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

// Pick at most n items spread evenly across arr (keeps first & last). Used to
// fit a span's snapshots into however many tiles its on-screen width allows
// without dropping the ends of the range.
function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return arr;
  if (n === 1) return [arr[Math.floor(arr.length / 2)]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return out;
}

// One timeline block rendered as a strip of preview thumbnails with a thin
// status bar on top. Gaps show the interval snapshots captured during them;
// jobs show their in-window snapshots too, falling back to the recording's own
// representative frame when a job is too short to contain a snapshot.
function FilmstripBlock({
  printerId,
  block,
  snaps,
  maxTiles,
  showLabel,
  selected,
  onClick,
  title,
  className,
  style,
}: {
  printerId: number;
  block: TimelineBlock;
  snaps: SnapPoint[];
  maxTiles: number;
  showLabel?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const isJob = block.type === 'job';
  const inRange = snaps.filter(s => s.ms >= block.start && s.ms <= block.end);
  const tiles = sampleEvenly(inRange, maxTiles);

  const imgs: { key: string; src: string }[] =
    tiles.length > 0
      ? tiles.map(s => ({ key: `s${s.id}`, src: api.getSnapshotImageUrl(printerId, s.id) }))
      : isJob
        ? [{ key: `t${block.recording.archive_id}`, src: api.getRecordingThumbnailUrl(printerId, block.recording.archive_id) }]
        : [];

  const statusCls = isJob ? jobClass(block.recording) : 'bg-bambu-dark-tertiary';
  const durLabel = formatDuration((block.end - block.start) / 1000);

  const inner = (
    <>
      {imgs.length > 0 && (
        <div className="absolute inset-0 flex">
          {imgs.map(im => (
            <img
              key={im.key}
              src={im.src}
              alt=""
              loading="lazy"
              className="h-full flex-1 min-w-0 object-cover"
              onError={e => {
                e.currentTarget.style.visibility = 'hidden';
              }}
            />
          ))}
        </div>
      )}
      <div className={`absolute top-0 left-0 right-0 h-1 ${statusCls}`} />
      {showLabel && (
        <span className="absolute bottom-0.5 left-0.5 text-[10px] leading-none text-white bg-bambu-dark/70 rounded px-1 py-0.5">
          {durLabel}
        </span>
      )}
    </>
  );

  const cls = `relative shrink-0 overflow-hidden border-r border-bambu-dark bg-bambu-dark-tertiary ${
    selected ? 'ring-2 ring-white ring-inset z-10' : ''
  } ${className ?? ''}`;

  return onClick ? (
    <button type="button" onClick={onClick} title={title} style={style} className={`${cls} cursor-pointer`}>
      {inner}
    </button>
  ) : (
    <div title={title} style={style} className={cls}>
      {inner}
    </div>
  );
}

interface CameraTimelineViewProps {
  printers: Printer[];
}

export function CameraTimelineView({ printers }: CameraTimelineViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activePrinterId, setActivePrinterId] = useState<number>(printers[0]?.id ?? 0);
  const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedChunks, setBufferedChunks] = useState<number[]>([]);
  const [speedKey, setSpeedKey] = useState<(typeof SPEEDS)[number]['key']>('normal');
  const speed = SPEEDS.find(s => s.key === speedKey) ?? SPEEDS[1];
  const [liveFollow, setLiveFollow] = useState(false);

  const recordingQueries = useQueries({
    queries: printers.map(p => ({
      queryKey: ['recordings', p.id],
      queryFn: () => api.getRecordings(p.id),
      refetchInterval: 5000,
    })),
  });
  const recordingsByPrinter = useMemo(() => {
    const map = new Map<number, CameraRecordingSummary[]>();
    printers.forEach((p, i) => map.set(p.id, recordingQueries[i]?.data ?? []));
    return map;
  }, [printers, recordingQueries]);

  // Ambient interval snapshots per printer over the retention window, used to
  // fill the timelines with previews (see FilmstripBlock). Fetched once for the
  // whole 7-day range so both the per-printer strip (24h slice) and the full
  // active-printer timeline can slice out whatever range they show.
  const snapshotsSince = useMemo(() => toNaiveUtcIso(Date.now() - 7 * 24 * 3600000), []);
  const snapshotQueries = useQueries({
    queries: printers.map(p => ({
      queryKey: ['snapshots', p.id, snapshotsSince],
      queryFn: () => api.listSnapshots(p.id, snapshotsSince),
      refetchInterval: 60000,
    })),
  });
  const snapshotsByPrinter = useMemo(() => {
    const map = new Map<number, SnapPoint[]>();
    printers.forEach((p, i) => {
      const pts = (snapshotQueries[i]?.data ?? [])
        .map(r => ({ id: r.id, ms: parseUTCDate(r.captured_at)?.getTime() ?? 0 }))
        .sort((a, b) => a.ms - b.ms);
      map.set(p.id, pts);
    });
    return map;
  }, [printers, snapshotQueries]);

  const activeRecordings = recordingsByPrinter.get(activePrinterId) ?? [];
  const activeSnaps = snapshotsByPrinter.get(activePrinterId) ?? [];
  const activeTimeline = useMemo(() => buildTimeline(activeRecordings), [activeRecordings]);
  const selectedRecording = activeRecordings.find(r => r.archive_id === selectedArchiveId) ?? null;
  const isLiveRecording = selectedRecording?.status === 'recording';
  const showLiveImage = liveFollow && isLiveRecording;

  const { data: frameList } = useQuery({
    queryKey: ['recording-frames', activePrinterId, selectedArchiveId],
    queryFn: () => api.getRecordingFrames(activePrinterId, selectedArchiveId as number),
    enabled: selectedArchiveId != null,
    refetchInterval: isLiveRecording ? 2000 : false,
  });
  const maxFrame = frameList && frameList.length > 0 ? frameList.length - 1 : 0;

  // Frame i's start time in seconds from the recording's first frame; the delta
  // between consecutive entries is the real captured gap the playback clock
  // reproduces (capped by MAX_GAP_SECONDS).
  const frameTimes = useMemo(() => {
    if (!frameList || frameList.length === 0) return [];
    const t0 = frameList[0].ts_ms;
    return frameList.map(f => (f.ts_ms - t0) / 1000);
  }, [frameList]);

  // --- Imperative player state (refs so the clock closure always sees latest) ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chunkCacheRef = useRef(new Map<number, ParsedChunk>());
  const chunkInflightRef = useRef(new Map<number, Promise<ParsedChunk | null>>());
  const bmpRef = useRef(new Map<number, ImageBitmap>());
  const bmpDecodingRef = useRef(new Set<number>());
  const timerRef = useRef<number | undefined>(undefined);
  const currentRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(speed.rate);
  const framesRef = useRef<FrameMeta[]>([]);
  const frameTimesRef = useRef<number[]>([]);
  const idsRef = useRef<{ printerId: number; archiveId: number }>({ printerId: 0, archiveId: 0 });
  const chunkCountRef = useRef(0);
  const firstRenderRef = useRef(false);

  useEffect(() => {
    speedRef.current = speed.rate;
  }, [speed.rate]);

  const updateBufferedBar = useCallback(() => {
    setBufferedChunks([...chunkCacheRef.current.keys()]);
  }, []);

  const loadChunk = useCallback(
    (ci: number): Promise<ParsedChunk | null> => {
      if (ci < 0 || ci >= chunkCountRef.current) return Promise.resolve(null);
      const cached = chunkCacheRef.current.get(ci);
      if (cached) return Promise.resolve(cached);
      const inflight = chunkInflightRef.current.get(ci);
      if (inflight) return inflight;

      const { printerId, archiveId } = idsRef.current;
      const p = (async () => {
        for (let tryN = 0; ; tryN++) {
          try {
            const r = await fetch(api.getRecordingPackUrl(printerId, archiveId, ci));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const parsed = parseChunk(await r.arrayBuffer());
            chunkCacheRef.current.set(ci, parsed);
            chunkInflightRef.current.delete(ci);
            updateBufferedBar();
            return parsed;
          } catch (e) {
            console.warn(`[sentry] chunk ${ci} fetch failed (try ${tryN})`, e);
            if (tryN >= CHUNK_MAX_RETRIES) {
              chunkInflightRef.current.delete(ci);
              return null;
            }
            await sleep(Math.min(2000, 150 * 2 ** tryN));
          }
        }
      })();
      chunkInflightRef.current.set(ci, p);
      return p;
    },
    [updateBufferedBar]
  );

  const frameBlob = useCallback((i: number): Blob | null => {
    const chunk = chunkCacheRef.current.get(Math.floor(i / CHUNK_FRAMES));
    if (!chunk) return null;
    const local = i % CHUNK_FRAMES;
    if (chunk.lens[local] == null) return null;
    return new Blob([new Uint8Array(chunk.buf, chunk.offs[local], chunk.lens[local])], { type: 'image/jpeg' });
  }, []);

  const decodeFrame = useCallback(
    async (i: number) => {
      if (bmpRef.current.has(i) || bmpDecodingRef.current.has(i)) return;
      const blob = frameBlob(i);
      if (!blob) return; // chunk not resident yet
      bmpDecodingRef.current.add(i);
      try {
        bmpRef.current.set(i, await createImageBitmap(blob));
      } catch {
        /* leave uncached; a redraw will retry */
      }
      bmpDecodingRef.current.delete(i);
    },
    [frameBlob]
  );

  const evict = useCallback((centerFrame: number) => {
    const centerChunk = Math.floor(centerFrame / CHUNK_FRAMES);
    for (const ci of chunkCacheRef.current.keys()) {
      if (ci < centerChunk - BACK_CHUNKS || ci > centerChunk + AHEAD_CHUNKS) chunkCacheRef.current.delete(ci);
    }
    for (const [i, b] of bmpRef.current) {
      if (i < centerFrame - BMP_BACK || i > centerFrame + BMP_AHEAD || !chunkCacheRef.current.has(Math.floor(i / CHUNK_FRAMES))) {
        b.close?.();
        bmpRef.current.delete(i);
      }
    }
  }, []);

  const prefetch = useCallback(
    (centerFrame: number) => {
      const ci = Math.floor(centerFrame / CHUNK_FRAMES);
      for (let d = 0; d <= AHEAD_CHUNKS; d++) loadChunk(ci + d);
      for (let d = 1; d <= BACK_CHUNKS; d++) loadChunk(ci - d);
      evict(centerFrame);
      updateBufferedBar();
    },
    [loadChunk, evict, updateBufferedBar]
  );

  const decodeWindow = useCallback(
    (center: number) => {
      for (let d = 0; d <= BMP_AHEAD; d++) {
        if (center + d < framesRef.current.length) decodeFrame(center + d);
        if (d <= BMP_BACK && center - d >= 0) decodeFrame(center - d);
      }
    },
    [decodeFrame]
  );

  const drawFrame = useCallback((bmp: ImageBitmap) => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== bmp.width || cv.height !== bmp.height) {
      cv.width = bmp.width;
      cv.height = bmp.height;
    }
    cv.getContext('2d')?.drawImage(bmp, 0, 0);
  }, []);

  // Renders frame i and keeps the buffer/decode windows filled around it.
  // Never throws: if the chunk can't load it just holds the current frame, so
  // the playback clock (scheduleNext) can never be killed by it.
  const showFrame = useCallback(
    async (i: number) => {
      const frames = framesRef.current;
      if (frames.length === 0) return;
      i = Math.max(0, Math.min(frames.length - 1, i));
      currentRef.current = i;
      let bmp = bmpRef.current.get(i);
      if (!bmp) {
        const ci = Math.floor(i / CHUNK_FRAMES);
        if (!chunkCacheRef.current.has(ci)) {
          setIsBuffering(true);
          await loadChunk(ci);
        }
        if (chunkCacheRef.current.has(ci)) {
          await decodeFrame(i);
          bmp = bmpRef.current.get(i);
        }
      }
      setIsBuffering(false);
      if (bmp) drawFrame(bmp);
      setCurrentFrame(i);
      prefetch(i);
      decodeWindow(i);
    },
    [loadChunk, decodeFrame, drawFrame, prefetch, decodeWindow]
  );

  const stopPlayback = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const scheduleNext = useCallback(() => {
    if (!playingRef.current) return;
    const frames = framesRef.current;
    if (currentRef.current >= frames.length - 1) {
      stopPlayback();
      return;
    }
    const ft = frameTimesRef.current;
    const dt = Math.min(MAX_GAP_SECONDS, (ft[currentRef.current + 1] ?? 0) - (ft[currentRef.current] ?? 0));
    timerRef.current = window.setTimeout(async () => {
      // try/finally makes the clock bulletproof: whatever showFrame does, the
      // next tick is always scheduled, so playback can never freeze dead.
      try {
        await showFrame(currentRef.current + 1);
      } catch (e) {
        console.warn('[sentry] showFrame error, continuing', e);
      } finally {
        scheduleNext();
      }
    }, Math.max(0, (dt * 1000) / speedRef.current));
  }, [showFrame, stopPlayback]);

  const startPlayback = useCallback(() => {
    if (framesRef.current.length === 0) return;
    setLiveFollow(false);
    if (currentRef.current >= framesRef.current.length - 1) currentRef.current = 0;
    playingRef.current = true;
    setPlaying(true);
    scheduleNext();
  }, [scheduleNext]);

  const seekToFrame = useCallback(
    (idx: number) => {
      showFrame(idx);
    },
    [showFrame]
  );

  const nudge = useCallback(
    (delta: number) => {
      if (framesRef.current.length === 0) return;
      stopPlayback();
      setLiveFollow(false);
      showFrame(currentRef.current + delta);
    },
    [stopPlayback, showFrame]
  );

  // Reset the whole player when the selected recording (or printer) changes.
  useEffect(() => {
    stopPlayback();
    chunkCacheRef.current.clear();
    chunkInflightRef.current.clear();
    bmpRef.current.forEach(b => b.close?.());
    bmpRef.current.clear();
    bmpDecodingRef.current.clear();
    currentRef.current = 0;
    firstRenderRef.current = false;
    setCurrentFrame(0);
    setBufferedChunks([]);
    setIsBuffering(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArchiveId, activePrinterId]);

  // Sync the latest frame data into the player refs; render the first frame
  // once frames arrive, and keep pinned to the live edge while following.
  useEffect(() => {
    if (!frameList || selectedArchiveId == null) return;
    framesRef.current = frameList;
    frameTimesRef.current = frameList.length > 0 ? frameList.map(f => (f.ts_ms - frameList[0].ts_ms) / 1000) : [];
    idsRef.current = { printerId: activePrinterId, archiveId: selectedArchiveId };
    chunkCountRef.current = Math.ceil(frameList.length / CHUNK_FRAMES);
    // The trailing chunk of a still-recording session grows -- drop it from the
    // cache so it refetches with the newest frames.
    if (isLiveRecording && chunkCountRef.current > 0) {
      chunkCacheRef.current.delete(chunkCountRef.current - 1);
    }
    if (frameList.length === 0) return;
    if (!firstRenderRef.current) {
      firstRenderRef.current = true;
      showFrame(liveFollow && isLiveRecording ? frameList.length - 1 : 0);
    } else if (liveFollow && isLiveRecording && !playingRef.current) {
      showFrame(frameList.length - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameList, activePrinterId, selectedArchiveId]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      bmpRef.current.forEach(b => b.close?.());
      bmpRef.current.clear();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (selectedArchiveId == null) return;
      if (e.key === 'ArrowLeft') nudge(-1);
      if (e.key === 'ArrowRight') nudge(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedArchiveId, nudge]);

  const keepForeverMutation = useMutation({
    mutationFn: ({ archiveId, keep }: { archiveId: number; keep: boolean }) =>
      api.setRecordingKeepForever(activePrinterId, archiveId, keep),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] }),
  });
  const downloadMutation = useMutation({
    mutationFn: (archiveId: number) => api.downloadRecording(activePrinterId, archiveId),
  });
  const downloadFrameMutation = useMutation({
    mutationFn: ({ archiveId, seq }: { archiveId: number; seq: number }) =>
      api.downloadFrameSnapshot(activePrinterId, archiveId, seq),
  });
  const deleteMutation = useMutation({
    mutationFn: (archiveId: number) => api.deleteRecording(activePrinterId, archiveId),
    onSuccess: (_data, archiveId) => {
      queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] });
      if (selectedArchiveId === archiveId) {
        setSelectedArchiveId(null);
        stopPlayback();
      }
    },
  });

  function selectRecording(r: CameraRecordingSummary) {
    stopPlayback();
    setSelectedArchiveId(r.archive_id);
    setLiveFollow(r.status === 'recording');
  }

  const now = Date.now();
  const dayAgo = now - 24 * 3600000;
  const currentTsMs = frameList?.[currentFrame]?.ts_ms;
  const playheadSec = frameTimes[currentFrame] ?? 0;
  const totalSec = frameTimes.length > 0 ? frameTimes[frameTimes.length - 1] : 0;
  const remainingSec = Math.max(0, totalSec - playheadSec);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Printer strip — 24h preview per printer: raw (time-proportional) + events (one tick per job) */}
      <div className="flex gap-3 overflow-x-auto pb-1 shrink-0">
        {printers.map(p => {
          const recs = (recordingsByPrinter.get(p.id) ?? []).filter(r => recordingEnd(r) > dayAgo);
          const isLive = recs.some(r => r.status === 'recording');
          const blocks = buildTimeline(recs);
          const jobBlocks = blocks.filter((b): b is JobBlock => b.type === 'job');
          return (
            <button
              key={p.id}
              onClick={() => { setActivePrinterId(p.id); setSelectedArchiveId(null); }}
              className={`shrink-0 w-56 text-left rounded-xl border p-3 transition-colors bg-bambu-dark-secondary ${
                activePrinterId === p.id ? 'border-bambu-green' : 'border-bambu-dark-tertiary hover:border-bambu-gray-dark'
              }`}
            >
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="font-medium text-white truncate">{p.name}</span>
                <span className={isLive ? 'text-bambu-green text-xs font-semibold shrink-0' : 'text-bambu-gray text-xs shrink-0'}>
                  {isLive ? t('camera.timeline.printing') : t('camera.timeline.idle')}
                </span>
              </div>
              <div className="flex h-10 rounded overflow-hidden bg-bambu-dark-tertiary" title={t('camera.timeline.rawTimeline')}>
                {blocks.map((b, i) => {
                  const clampedStart = Math.max(b.start, dayAgo);
                  const width = ((b.end - clampedStart) / (now - dayAgo)) * 100;
                  const approxPx = (width / 100) * 200; // card content ≈ 200px wide
                  const maxTiles = Math.max(1, Math.min(8, Math.floor(approxPx / 20)));
                  return (
                    <FilmstripBlock
                      key={i}
                      printerId={p.id}
                      block={{ ...b, start: clampedStart }}
                      snaps={snapshotsByPrinter.get(p.id) ?? []}
                      maxTiles={maxTiles}
                      className="h-full"
                      style={{ width: `${width}%` }}
                    />
                  );
                })}
              </div>
              <div className="flex justify-between text-[10px] text-bambu-gray mt-1 mb-1.5">
                <span>{t('camera.timeline.hoursAgo', { count: 24 })}</span>
                <span>{t('camera.timeline.now')}</span>
              </div>
              <div className="flex gap-0.5 h-1.5" title={t('camera.timeline.eventsTimeline')}>
                {jobBlocks.length === 0 ? (
                  <div className="flex-1 rounded-full bg-bambu-dark-tertiary opacity-40" />
                ) : (
                  jobBlocks.map((b, i) => (
                    <div key={i} className={`flex-1 rounded-full ${jobClass(b.recording)}`} />
                  ))
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Viewport + stats overlay. min-h-0 lets flex-1 size this box to the
          remaining space rather than the canvas's intrinsic size. */}
      <Card className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        {!selectedRecording ? (
          <p className="text-bambu-gray text-sm px-6 text-center">{t('camera.timeline.selectPrompt')}</p>
        ) : (
          <>
            <div className="absolute top-3 left-3 bg-bambu-dark/90 border border-bambu-dark-tertiary rounded-lg p-3 text-xs min-w-[190px] z-10">
              <p className="text-white font-medium mb-2 truncate">{selectedRecording.file ?? selectedRecording.print_name ?? `#${selectedRecording.archive_id}`}</p>
              <StatRow label={t('camera.timeline.stats.printer')} value={printers.find(p => p.id === selectedRecording.printer_id)?.name ?? '—'} />
              <StatRow label={t('camera.timeline.stats.filament')} value={selectedRecording.filament_type ?? '—'} />
              <StatRow
                label={t('camera.timeline.stats.start')}
                value={parseUTCDate(selectedRecording.started_at)?.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) ?? '—'}
              />
              <StatRow
                label={isLiveRecording ? t('camera.timeline.stats.elapsed') : t('camera.timeline.stats.duration')}
                value={formatDuration((recordingEnd(selectedRecording) - recordingStart(selectedRecording)) / 1000)}
              />
              <StatRow label={t('settings.sentryFrames')} value={String(selectedRecording.frame_count)} />
              <span className={`inline-block mt-2 px-2 py-0.5 rounded text-[10px] font-semibold ${jobClass(selectedRecording)}`}>
                {(selectedRecording.archive_status ?? selectedRecording.status).toUpperCase()}
              </span>
            </div>

            {isLiveRecording && !liveFollow && (
              <Button
                variant="primary"
                size="sm"
                className="absolute top-3 right-3 z-10"
                onClick={() => { setLiveFollow(true); if (maxFrame > 0) showFrame(maxFrame); }}
              >
                {t('camera.timeline.jumpToLive')}
              </Button>
            )}

            {/* Live: show the raw camera stream (trivially reliable, no buffering).
                Otherwise: the image-sequence canvas. */}
            {showLiveImage ? (
              <img src={api.getCameraStreamUrl(activePrinterId, 15)} alt="" className="w-full h-full object-contain" />
            ) : (
              <>
                <canvas
                  ref={canvasRef}
                  onClick={() => (playing ? stopPlayback() : startPlayback())}
                  className="w-full h-full object-contain cursor-pointer"
                  title={playing ? t('camera.timeline.pause') : t('camera.timeline.play')}
                />
                {isBuffering && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/40 pointer-events-none">
                    <div className="flex items-center gap-2 bg-bambu-dark/90 text-white text-xs px-3 py-1.5 rounded-full">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {t('camera.timeline.buffering')}
                    </div>
                  </div>
                )}
                {(!frameList || frameList.length === 0) && (
                  <p className="absolute text-bambu-gray text-sm">{t('settings.sentryNoRecordings')}</p>
                )}
              </>
            )}
            {showLiveImage ? (
              <span className="absolute bottom-3 left-3 text-xs text-white bg-bambu-dark/80 px-2 py-1 rounded">
                <span className="text-bambu-green font-semibold">{t('camera.timeline.live')}</span>
              </span>
            ) : (
              currentTsMs != null && (
                <span className="absolute bottom-3 left-3 text-xs text-white bg-bambu-dark/80 px-2 py-1 rounded">
                  {new Date(currentTsMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )
            )}
          </>
        )}
      </Card>

      {/* Playback controls */}
      {selectedRecording && (
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <Button variant="secondary" size="sm" onClick={() => nudge(-1)} title={t('camera.timeline.prevFrame')}>
            <SkipBack className="w-4 h-4" />
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => (playing ? stopPlayback() : startPlayback())}
            disabled={!frameList || frameList.length === 0}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => nudge(1)} title={t('camera.timeline.nextFrame')}>
            <SkipForward className="w-4 h-4" />
          </Button>
          <span className="font-mono text-xs text-bambu-gray shrink-0 tabular-nums">{formatMediaTime(playheadSec)}</span>
          <div className="relative flex-1 min-w-[120px] h-4 flex items-center">
            {frameTimes.length > 0 && (
              // Light-gray = resident (buffered) chunks behind the scrub thumb.
              <div className="absolute left-0 h-1 w-full rounded-full bg-bambu-dark-tertiary overflow-hidden pointer-events-none">
                {bufferedChunks.map(ci => {
                  const total = frameTimes.length || 1;
                  const startFrame = ci * CHUNK_FRAMES;
                  const frameCount = Math.min(CHUNK_FRAMES, total - startFrame);
                  if (frameCount <= 0) return null;
                  return (
                    <div
                      key={ci}
                      className="absolute h-full bg-bambu-gray-dark/70"
                      style={{ left: `${(startFrame / total) * 100}%`, width: `${(frameCount / total) * 100}%` }}
                      title={t('camera.timeline.buffered')}
                    />
                  );
                })}
              </div>
            )}
            <input
              type="range"
              min={0}
              max={maxFrame}
              value={currentFrame}
              onChange={e => {
                setLiveFollow(false);
                seekToFrame(Number(e.target.value));
              }}
              className="relative w-full h-1 appearance-none bg-transparent cursor-pointer accent-bambu-green [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent"
            />
          </div>
          <span className="font-mono text-xs text-bambu-gray shrink-0 tabular-nums">-{formatMediaTime(remainingSec)}</span>
          <select
            value={speedKey}
            onChange={e => setSpeedKey(e.target.value as (typeof SPEEDS)[number]['key'])}
            aria-label={t('camera.timeline.speedLabel')}
            title={t('camera.timeline.speedLabel')}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-bambu-dark-tertiary text-white border border-bambu-dark-tertiary hover:border-bambu-gray-dark focus:outline-none focus:border-bambu-green cursor-pointer"
          >
            {SPEEDS.map(s => (
              <option key={s.key} value={s.key}>
                {t(`camera.timeline.speed.${s.key}`)}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              frameList &&
              downloadFrameMutation.mutate({ archiveId: selectedRecording.archive_id, seq: frameList[currentFrame].seq })
            }
            title={t('camera.timeline.downloadFrame')}
            className="text-bambu-gray hover:text-white disabled:opacity-50"
            disabled={downloadFrameMutation.isPending || !frameList || frameList.length === 0}
          >
            {downloadFrameMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageDown className="w-4 h-4" />}
          </button>
          <button
            onClick={() => downloadMutation.mutate(selectedRecording.archive_id)}
            title={t('camera.timeline.download')}
            className="text-bambu-gray hover:text-white disabled:opacity-50"
            disabled={downloadMutation.isPending || !frameList || frameList.length === 0}
          >
            {downloadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          </button>
          <button
            onClick={() => keepForeverMutation.mutate({ archiveId: selectedRecording.archive_id, keep: !selectedRecording.keep_forever })}
            title={t('settings.sentryKeepForever')}
            className={selectedRecording.keep_forever ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'}
          >
            <Star className="w-4 h-4" fill={selectedRecording.keep_forever ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => deleteMutation.mutate(selectedRecording.archive_id)}
            title={t('settings.sentryDeleteRecording')}
            className="text-bambu-gray hover:text-red-400"
            disabled={isLiveRecording}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Full timeline for the active printer — raw/time-proportional */}
      <Card className="shrink-0">
        <CardHeader className="flex items-center justify-between text-xs text-bambu-gray" dense>
          <span className="text-white font-medium">{printers.find(p => p.id === activePrinterId)?.name}</span>
          <span>{t('camera.timeline.retentionNote', { days: 7 })}</span>
        </CardHeader>
        <CardContent className="overflow-x-auto" dense>
          {activeTimeline.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('settings.sentryNoRecordings')}</p>
          ) : (
            <div className="flex h-20 min-w-max">
              {activeTimeline.map((b, i) => {
                const durMs = b.end - b.start;
                const widthPx = Math.max(44, Math.min(360, (durMs / 3600000) * 90));
                const maxTiles = Math.max(1, Math.min(16, Math.floor(widthPx / 28)));
                const isJob = b.type === 'job';
                const title = isJob
                  ? `${b.recording.file ?? ''} — ${formatDuration(durMs / 1000)} — ${b.recording.archive_status ?? b.recording.status} — ${formatFileSize(b.recording.size_bytes)}`
                  : `${t('camera.timeline.idle')} — ${formatDuration(durMs / 1000)}`;
                return (
                  <FilmstripBlock
                    key={i}
                    printerId={activePrinterId}
                    block={b}
                    snaps={activeSnaps}
                    maxTiles={maxTiles}
                    showLabel
                    title={title}
                    selected={isJob && selectedArchiveId === b.recording.archive_id}
                    onClick={isJob ? () => selectRecording(b.recording) : undefined}
                    style={{ width: widthPx }}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
