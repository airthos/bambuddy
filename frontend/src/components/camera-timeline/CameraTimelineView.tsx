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
//
// The same player also scrubs *standby clips*: the idle stretches between
// jobs, played from the ambient interval snapshots (one JPEG each, fetched
// per frame) instead of packed recording chunks. The clock/scrub/speed logic
// is source-agnostic; only "get frame i's bytes" differs by mode.

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
// Standby-clip frames are individual snapshot JPEGs, not packed chunks, so the
// buffer window is counted in frames. Gaps hold few snapshots (one every N
// minutes) so a generous window still costs little.
const SNAP_AHEAD = 40;
const SNAP_BACK = 10;
// Real-time playback reproduces the true seconds between frames, but capture
// has big idle gaps (printer offline / paused). Playing those out in real time
// looks like a dead freeze on one frame; cap the per-frame dwell so idle time
// is skipped fast instead of stalling.
const MAX_GAP_SECONDS = 4;
// Retries per chunk/snapshot before giving up. A failed fetch must NEVER
// propagate into the playback clock (that was the original freeze) -- the
// loader resolves to null on give-up and the clock keeps ticking regardless.
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

// What the player is currently pointed at: a recording (packed chunks) or a
// standby gap (interval snapshots in a time range).
type Selection =
  | { kind: 'recording'; archiveId: number }
  | { kind: 'gap'; start: number; end: number };

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
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const start = recordingStart(r);
    // Guard against a bad/late stopped_at (e.g. a session the restart sweep
    // closed hours after its last frame): never let a block overrun the next
    // job's start, and never render into the future.
    const nextStart = i + 1 < sorted.length ? recordingStart(sorted[i + 1]) : Infinity;
    const end = Math.max(start, Math.min(recordingEnd(r), nextStart));
    if (cursor !== null && start > cursor) {
      blocks.push({ type: 'gap', start: cursor, end: start });
    }
    blocks.push({ type: 'job', recording: r, start, end });
    cursor = end;
  }
  return blocks;
}

// Color by the *print outcome* (what the user cares about), not the recording
// lifecycle. An 'orphaned' recording is flagged separately with a subtle marker
// (see isOrphaned) rather than an alarming color -- the print itself usually
// finished fine; only the recording didn't close cleanly.
function jobClass(r: CameraRecordingSummary): string {
  if (r.status === 'recording') return 'bg-bambu-green text-white';
  if (r.archive_status === 'failed') return 'bg-red-900/80 text-red-200';
  if (r.archive_status === 'cancelled' || r.archive_status === 'aborted') return 'bg-yellow-700/80 text-yellow-100';
  return 'bg-blue-600/70 text-white';
}

// A recording that didn't close cleanly (watchdog/restart-swept) -- shown with
// a small amber marker so a truncated recording is distinguishable without
// making a completed print look failed.
function isOrphaned(r: CameraRecordingSummary): boolean {
  return r.status === 'orphaned';
}

function jobLabel(r: CameraRecordingSummary): string {
  return r.file ?? r.print_name ?? `#${r.archive_id}`;
}

function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-sm ${swatch}`} />
      {label}
    </span>
  );
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
// in the idle gaps between them -- which is what both fills the filmstrip and
// makes the standby stretches scrubbable.
interface SnapPoint {
  id: number;
  ms: number;
}

// Naive-UTC ISO (no 'Z'/offset) to match how the backend stores/compares
// captured_at; the 'since' query param is parsed as naive UTC there.
const toNaiveUtcIso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

const shortTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// The filmstrip timelines scroll horizontally, but a plain mouse wheel only
// produces deltaY and browsers don't apply that to a horizontal scroller -- so
// the strips read as frozen. In the detail view there's no page scroll to fall
// back on either (the layout fills the viewport), which made the wheel feel
// dead over the timeline. Translate vertical wheel into horizontal scroll, and
// bow out once the strip reaches an end so the gesture still falls through to
// whatever scrolls behind it.
// Returns [ref-callback to spread onto the scroller, a live ref to the element].
// A callback ref rather than useRef+useEffect because these scrollers mount
// after their data arrives -- a mount-time effect would find null and silently
// never attach.
function useWheelToHorizontal<T extends HTMLElement>() {
  const elRef = useRef<T | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const attach = useCallback((el: T | null) => {
    detachRef.current?.();
    detachRef.current = null;
    elRef.current = el;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Leave real horizontal gestures (trackpad swipe) to the browser.
      if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return; // nothing to scroll -- let whatever is behind have it
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line-mode wheels report ~3
      e.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + step));
    };
    // Must be a non-passive native listener: React's onWheel can't preventDefault.
    el.addEventListener('wheel', onWheel, { passive: false });
    detachRef.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
  return [attach, elRef] as const;
}

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

// One timeline block rendered as a strip of preview thumbnails. Jobs stay
// full-color under a colored status cap (thick on the main timeline) and get an
// optional filename footer; idle gaps are desaturated and dimmed so recordings
// read as distinct events, with an optional snapshot-count pill. Gaps that hold
// snapshots are clickable to scrub as a standby clip.
function FilmstripBlock({
  printerId,
  block,
  snaps,
  maxTiles,
  thickCap,
  jobFooter,
  gapPill,
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
  thickCap?: boolean;
  jobFooter?: string;
  gapPill?: string;
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

  const inner = (
    <>
      {imgs.length > 0 && (
        <div className="absolute inset-0 flex" style={isJob ? undefined : { filter: 'grayscale(0.7) brightness(0.55)' }}>
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
      {isJob ? (
        <div className={`absolute top-0 left-0 right-0 ${thickCap ? 'h-1' : 'h-[3px]'} ${jobClass(block.recording)}`} />
      ) : (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-bambu-gray-dark/50" />
      )}
      {isJob && isOrphaned(block.recording) && (
        <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400 ring-1 ring-black/50 z-10" />
      )}
      {isJob && jobFooter && (
        <div className="absolute inset-x-0 bottom-0 h-[18px] flex items-center px-1.5 bg-gradient-to-t from-black/80 to-transparent text-[10px] leading-none font-medium text-white truncate">
          {jobFooter}
        </div>
      )}
      {!isJob && gapPill && (
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-mono text-bambu-gray bg-black/55 border border-bambu-dark-tertiary rounded-full px-1.5 py-0.5 whitespace-nowrap">
          {gapPill}
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

// Compact per-printer timeline in the camera picker: mirrors the main timeline
// but time-proportional over the last 24h, with a hard NOW edge on the right so
// a running print always butts up against it. Leads with the last job's file
// preview (the same plate render bambuddy shows in Archives/Calendar).
function MiniTimeline({
  printerId,
  blocks,
  snaps,
  dayAgo,
  now,
}: {
  printerId: number;
  blocks: TimelineBlock[];
  snaps: SnapPoint[];
  dayAgo: number;
  now: number;
}) {
  const lastJob = [...blocks].reverse().find((b): b is JobBlock => b.type === 'job');
  return (
    <div className="flex gap-2">
      <div className="w-11 h-11 shrink-0 rounded-md overflow-hidden border border-bambu-dark-tertiary bg-bambu-dark">
        {lastJob && (
          <img
            src={api.getArchiveThumbnail(lastJob.recording.archive_id)}
            alt=""
            className="w-full h-full object-cover"
            onError={e => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative flex h-9 rounded overflow-hidden bg-bambu-dark-tertiary">
          {blocks.map((b, i) => {
            const clampedStart = Math.max(b.start, dayAgo);
            const width = ((b.end - clampedStart) / (now - dayAgo)) * 100;
            const approxPx = (width / 100) * 180;
            const maxTiles = Math.max(1, Math.min(8, Math.floor(approxPx / 18)));
            return (
              <FilmstripBlock
                key={i}
                printerId={printerId}
                block={{ ...b, start: clampedStart }}
                snaps={snaps}
                maxTiles={maxTiles}
                className="h-full"
                style={{ width: `${width}%` }}
              />
            );
          })}
          {/* Hard NOW edge — a live print's block ends here, so it reads as current. */}
          <div className="absolute right-0 top-0 bottom-0 w-0.5 bg-white z-20" />
        </div>
        <div className="flex justify-between text-[10px] font-mono text-bambu-gray mt-1">
          <span>-24h</span>
          <span>now</span>
        </div>
      </div>
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferedChunks, setBufferedChunks] = useState<number[]>([]);
  const [speedKey, setSpeedKey] = useState<(typeof SPEEDS)[number]['key']>('normal');
  const speed = SPEEDS.find(s => s.key === speedKey) ?? SPEEDS[1];
  const [liveFollow, setLiveFollow] = useState(false);

  const selectedArchiveId = selection?.kind === 'recording' ? selection.archiveId : null;
  const isGap = selection?.kind === 'gap';

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
  // fill the timelines with previews and to play back standby clips. Fetched
  // once for the whole 7-day range so both the per-printer strip (24h slice)
  // and the full active-printer timeline can slice out whatever range they show.
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

  // Undefined data means "still loading" -- distinct from a printer that really
  // has no recordings, which matters for the auto-select below.
  const recordingsLoaded = recordingQueries.length === 0 || recordingQueries.some(q => q.data != null);

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

  // The snapshots that make up the selected standby clip (gap mode).
  const gapSnaps = useMemo(() => {
    if (selection?.kind !== 'gap') return [];
    return activeSnaps.filter(s => s.ms >= selection.start && s.ms <= selection.end);
  }, [selection, activeSnaps]);

  // Unified frame list the controls/scrub bar read, regardless of source.
  const clipFrames: FrameMeta[] = useMemo(() => {
    if (selection?.kind === 'recording') return frameList ?? [];
    if (selection?.kind === 'gap') return gapSnaps.map((s, i) => ({ seq: i, ts_ms: s.ms }));
    return [];
  }, [selection, frameList, gapSnaps]);
  const maxFrame = clipFrames.length > 0 ? clipFrames.length - 1 : 0;

  // Frame i's start time in seconds from the clip's first frame; the delta
  // between consecutive entries is the real captured gap the playback clock
  // reproduces (capped by MAX_GAP_SECONDS).
  const frameTimes = useMemo(() => {
    if (clipFrames.length === 0) return [];
    const t0 = clipFrames[0].ts_ms;
    return clipFrames.map(f => (f.ts_ms - t0) / 1000);
  }, [clipFrames]);

  // --- Imperative player state (refs so the clock closure always sees latest) ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef<'recording' | 'gap'>('recording');
  const chunkCacheRef = useRef(new Map<number, ParsedChunk>());
  const chunkInflightRef = useRef(new Map<number, Promise<ParsedChunk | null>>());
  const snapBlobRef = useRef(new Map<number, Blob>()); // gap: fetched JPEG per frame index
  const snapInflightRef = useRef(new Map<number, Promise<Blob | null>>());
  const snapIdsRef = useRef<number[]>([]); // gap: snapshot id per frame index
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

  // Standby-clip counterpart of loadChunk: fetch one snapshot's JPEG for frame
  // index i. Never throws -- resolves to null on give-up so the clock survives.
  const loadSnapBlob = useCallback((i: number): Promise<Blob | null> => {
    if (i < 0 || i >= snapIdsRef.current.length) return Promise.resolve(null);
    const cached = snapBlobRef.current.get(i);
    if (cached) return Promise.resolve(cached);
    const inflight = snapInflightRef.current.get(i);
    if (inflight) return inflight;

    const { printerId } = idsRef.current;
    const id = snapIdsRef.current[i];
    const p = (async () => {
      for (let tryN = 0; ; tryN++) {
        try {
          const r = await fetch(api.getSnapshotImageUrl(printerId, id));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const blob = await r.blob();
          snapBlobRef.current.set(i, blob);
          snapInflightRef.current.delete(i);
          return blob;
        } catch (e) {
          console.warn(`[sentry] snapshot ${id} fetch failed (try ${tryN})`, e);
          if (tryN >= CHUNK_MAX_RETRIES) {
            snapInflightRef.current.delete(i);
            return null;
          }
          await sleep(Math.min(2000, 150 * 2 ** tryN));
        }
      }
    })();
    snapInflightRef.current.set(i, p);
    return p;
  }, []);

  const frameBlob = useCallback((i: number): Blob | null => {
    if (modeRef.current === 'gap') return snapBlobRef.current.get(i) ?? null;
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
      if (!blob) return; // bytes not resident yet
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

  const prefetch = useCallback(
    (centerFrame: number) => {
      if (modeRef.current === 'gap') {
        for (let d = 0; d <= SNAP_AHEAD; d++) {
          const j = centerFrame + d;
          if (j < framesRef.current.length) loadSnapBlob(j).then(() => decodeFrame(j));
        }
        for (let d = 1; d <= SNAP_BACK; d++) {
          const j = centerFrame - d;
          if (j >= 0) loadSnapBlob(j).then(() => decodeFrame(j));
        }
        for (const i of snapBlobRef.current.keys()) {
          if (i < centerFrame - SNAP_BACK || i > centerFrame + SNAP_AHEAD) snapBlobRef.current.delete(i);
        }
        for (const [i, b] of bmpRef.current) {
          if (i < centerFrame - SNAP_BACK || i > centerFrame + SNAP_AHEAD) {
            b.close?.();
            bmpRef.current.delete(i);
          }
        }
        return;
      }
      const ci = Math.floor(centerFrame / CHUNK_FRAMES);
      for (let d = 0; d <= AHEAD_CHUNKS; d++) loadChunk(ci + d);
      for (let d = 1; d <= BACK_CHUNKS; d++) loadChunk(ci - d);
      const centerChunk = Math.floor(centerFrame / CHUNK_FRAMES);
      for (const c of chunkCacheRef.current.keys()) {
        if (c < centerChunk - BACK_CHUNKS || c > centerChunk + AHEAD_CHUNKS) chunkCacheRef.current.delete(c);
      }
      for (const [i, b] of bmpRef.current) {
        if (i < centerFrame - BMP_BACK || i > centerFrame + BMP_AHEAD || !chunkCacheRef.current.has(Math.floor(i / CHUNK_FRAMES))) {
          b.close?.();
          bmpRef.current.delete(i);
        }
      }
      updateBufferedBar();
    },
    [loadChunk, loadSnapBlob, decodeFrame, updateBufferedBar]
  );

  const decodeWindow = useCallback(
    (center: number) => {
      const ahead = modeRef.current === 'gap' ? SNAP_AHEAD : BMP_AHEAD;
      const back = modeRef.current === 'gap' ? SNAP_BACK : BMP_BACK;
      for (let d = 0; d <= ahead; d++) {
        if (center + d < framesRef.current.length) decodeFrame(center + d);
        if (d <= back && center - d >= 0) decodeFrame(center - d);
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
  // Never throws: if the bytes can't load it just holds the current frame, so
  // the playback clock (scheduleNext) can never be killed by it.
  const showFrame = useCallback(
    async (i: number) => {
      const frames = framesRef.current;
      if (frames.length === 0) return;
      i = Math.max(0, Math.min(frames.length - 1, i));
      currentRef.current = i;
      let bmp = bmpRef.current.get(i);
      if (!bmp) {
        if (modeRef.current === 'gap') {
          if (!snapBlobRef.current.has(i)) {
            setIsBuffering(true);
            await loadSnapBlob(i);
          }
          if (snapBlobRef.current.has(i)) {
            await decodeFrame(i);
            bmp = bmpRef.current.get(i);
          }
        } else {
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
      }
      setIsBuffering(false);
      if (bmp) drawFrame(bmp);
      setCurrentFrame(i);
      prefetch(i);
      decodeWindow(i);
    },
    [loadChunk, loadSnapBlob, decodeFrame, drawFrame, prefetch, decodeWindow]
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

  // Key that changes exactly when the player must reset (new clip or printer).
  const clipKey = selection
    ? selection.kind === 'recording'
      ? `r:${selection.archiveId}`
      : `g:${selection.start}:${selection.end}`
    : null;

  // Reset the whole player when the selected clip (or printer) changes.
  useEffect(() => {
    stopPlayback();
    chunkCacheRef.current.clear();
    chunkInflightRef.current.clear();
    snapBlobRef.current.clear();
    snapInflightRef.current.clear();
    snapIdsRef.current = [];
    bmpRef.current.forEach(b => b.close?.());
    bmpRef.current.clear();
    bmpDecodingRef.current.clear();
    currentRef.current = 0;
    firstRenderRef.current = false;
    setCurrentFrame(0);
    setBufferedChunks([]);
    setIsBuffering(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipKey, activePrinterId]);

  // Sync the latest frame data into the player refs; render the first frame
  // once frames arrive, and keep pinned to the live edge while following.
  useEffect(() => {
    if (selection == null || clipFrames.length === 0) return;
    modeRef.current = selection.kind === 'gap' ? 'gap' : 'recording';
    framesRef.current = clipFrames;
    frameTimesRef.current = clipFrames.map(f => (f.ts_ms - clipFrames[0].ts_ms) / 1000);
    idsRef.current = { printerId: activePrinterId, archiveId: selectedArchiveId ?? 0 };
    if (selection.kind === 'gap') {
      snapIdsRef.current = gapSnaps.map(s => s.id);
      chunkCountRef.current = 0;
    } else {
      chunkCountRef.current = Math.ceil(clipFrames.length / CHUNK_FRAMES);
      // The trailing chunk of a still-recording session grows -- drop it from
      // the cache so it refetches with the newest frames.
      if (isLiveRecording && chunkCountRef.current > 0) {
        chunkCacheRef.current.delete(chunkCountRef.current - 1);
      }
    }
    if (!firstRenderRef.current) {
      firstRenderRef.current = true;
      showFrame(liveFollow && isLiveRecording ? clipFrames.length - 1 : 0);
    } else if (liveFollow && isLiveRecording && !playingRef.current) {
      showFrame(clipFrames.length - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipFrames, activePrinterId, selection]);

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
      if (selection == null) return;
      if (e.key === 'ArrowLeft') nudge(-1);
      if (e.key === 'ArrowRight') nudge(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, nudge]);

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
  const downloadSnapshotMutation = useMutation({
    mutationFn: (snapshotId: number) => api.downloadSnapshot(activePrinterId, snapshotId),
  });
  const deleteMutation = useMutation({
    mutationFn: (archiveId: number) => api.deleteRecording(activePrinterId, archiveId),
    onSuccess: (_data, archiveId) => {
      queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] });
      if (selectedArchiveId === archiveId) {
        setSelection(null);
        stopPlayback();
      }
    },
  });

  function selectRecording(r: CameraRecordingSummary) {
    stopPlayback();
    setSelection({ kind: 'recording', archiveId: r.archive_id });
    setLiveFollow(r.status === 'recording');
  }
  function selectGap(start: number, end: number) {
    stopPlayback();
    setSelection({ kind: 'gap', start, end });
    setLiveFollow(false);
  }

  // --- Land on whatever is happening right now ---
  // Opening the page (or switching printers) with an empty viewport hides the
  // thing you almost always came for: the print that's running. Pick it
  // automatically. Selecting an in-progress recording turns on live-follow,
  // which is what renders the live camera stream rather than the scrubber.
  const initialPrinterRef = useRef(false);
  useEffect(() => {
    if (initialPrinterRef.current || !recordingsLoaded) return;
    initialPrinterRef.current = true; // only ever the initial pick -- never yank the user later
    const livePrinter = printers.find(p => (recordingsByPrinter.get(p.id) ?? []).some(r => r.status === 'recording'));
    if (livePrinter) setActivePrinterId(livePrinter.id);
  }, [printers, recordingsByPrinter, recordingsLoaded]);

  useEffect(() => {
    if (selection != null) return; // never clobber a selection the user made
    const live = (recordingsByPrinter.get(activePrinterId) ?? []).find(r => r.status === 'recording');
    if (!live) return;
    setSelection({ kind: 'recording', archiveId: live.archive_id });
    setLiveFollow(true);
  }, [selection, activePrinterId, recordingsByPrinter]);

  const [pickerScrollRef] = useWheelToHorizontal<HTMLDivElement>();
  const [timelineScrollRef, timelineScrollEl] = useWheelToHorizontal<HTMLDivElement>();

  // Open on the recent end of the timeline: "now" is the right edge, so a
  // running print sits there, and the far left is up to 7 days stale.
  useEffect(() => {
    const el = timelineScrollEl.current;
    if (el) el.scrollLeft = el.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePrinterId, activeTimeline.length]);

  const now = Date.now();
  const dayAgo = now - 24 * 3600000;
  const currentTsMs = clipFrames[currentFrame]?.ts_ms;
  const playheadSec = frameTimes[currentFrame] ?? 0;
  const totalSec = frameTimes.length > 0 ? frameTimes[frameTimes.length - 1] : 0;
  const remainingSec = Math.max(0, totalSec - playheadSec);
  const hasClip = selection != null && clipFrames.length > 0;
  const downloadFramePending = downloadFrameMutation.isPending || downloadSnapshotMutation.isPending;

  // Widths (px) for the main timeline blocks; shared by the rail and the strip
  // so the boundary ticks line up with the block edges.
  const blockWidths = activeTimeline.map(b => Math.max(44, Math.min(360, ((b.end - b.start) / 3600000) * 90)));

  return (
    // overflow-y-auto + a floor under the viewport below: on a short window the
    // fixed-height rows (picker, controls, timeline) used to overflow a clipped
    // container, putting the timeline permanently out of reach. Now the column
    // scrolls instead of swallowing it.
    <div className="flex flex-col gap-3 h-full min-h-0 overflow-y-auto">
      {/* Printer picker — a mini mirror of the main timeline per printer */}
      <div ref={pickerScrollRef} className="flex gap-3 overflow-x-auto pb-1 shrink-0">
        {printers.map(p => {
          const recs = (recordingsByPrinter.get(p.id) ?? []).filter(r => recordingEnd(r) > dayAgo);
          const isLive = recs.some(r => r.status === 'recording');
          const blocks = buildTimeline(recs);
          return (
            <button
              key={p.id}
              onClick={() => {
                setActivePrinterId(p.id);
                setSelection(null);
              }}
              className={`shrink-0 w-64 text-left rounded-xl border p-3 transition-colors bg-bambu-dark-secondary ${
                activePrinterId === p.id ? 'border-bambu-green' : 'border-bambu-dark-tertiary hover:border-bambu-gray-dark'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium text-white truncate">{p.name}</span>
                <span
                  className={`ml-auto shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                    isLive
                      ? 'bg-bambu-green/15 text-bambu-green border-bambu-green/40'
                      : 'bg-bambu-dark-tertiary text-bambu-gray border-bambu-dark-tertiary'
                  }`}
                >
                  {isLive ? t('camera.timeline.printing') : t('camera.timeline.idle')}
                </span>
              </div>
              <MiniTimeline printerId={p.id} blocks={blocks} snaps={snapshotsByPrinter.get(p.id) ?? []} dayAgo={dayAgo} now={now} />
            </button>
          );
        })}
      </div>

      {/* Viewport + stats overlay. flex-1 sizes this box to the remaining space
          rather than the canvas's intrinsic size; the min-height is a floor so a
          short window scrolls the column (see above) instead of collapsing the
          video to nothing. */}
      <Card className="relative flex-1 min-h-[220px] flex items-center justify-center overflow-hidden">
        {!selection ? (
          <p className="text-bambu-gray text-sm px-6 text-center">{t('camera.timeline.selectPrompt')}</p>
        ) : (
          <>
            {isGap ? (
              <div className="absolute top-3 left-3 bg-bambu-dark/90 border border-bambu-dark-tertiary rounded-lg p-3 text-xs min-w-[190px] z-10">
                <p className="text-white font-medium mb-2">{t('camera.timeline.standby')}</p>
                <StatRow label={t('camera.timeline.stats.printer')} value={printers.find(p => p.id === activePrinterId)?.name ?? '—'} />
                <StatRow label={t('camera.timeline.stats.start')} value={selection.kind === 'gap' ? shortTime(selection.start) : '—'} />
                <StatRow
                  label={t('camera.timeline.stats.duration')}
                  value={selection.kind === 'gap' ? formatDuration((selection.end - selection.start) / 1000) : '—'}
                />
                <StatRow label={t('camera.timeline.snapshots')} value={String(clipFrames.length)} />
                <span className="inline-block mt-2 px-2 py-0.5 rounded text-[10px] font-semibold bg-bambu-dark-tertiary text-bambu-gray">
                  {t('camera.timeline.standby').toUpperCase()}
                </span>
              </div>
            ) : (
              selectedRecording && (
                <div className="absolute top-3 left-3 bg-bambu-dark/90 border border-bambu-dark-tertiary rounded-lg p-3 text-xs min-w-[190px] z-10">
                  <div className="flex gap-2 items-center mb-2">
                    <img
                      src={api.getArchiveThumbnail(selectedRecording.archive_id)}
                      alt=""
                      className="w-11 h-11 shrink-0 rounded object-cover border border-bambu-dark-tertiary bg-bambu-dark"
                      onError={e => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                    <p className="text-white font-medium truncate">{jobLabel(selectedRecording)}</p>
                  </div>
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
              )
            )}

            {isLiveRecording && !liveFollow && (
              <Button
                variant="primary"
                size="sm"
                className="absolute top-3 right-3 z-10"
                onClick={() => {
                  setLiveFollow(true);
                  if (maxFrame > 0) showFrame(maxFrame);
                }}
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
                {clipFrames.length === 0 && (
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
      {selection && (
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <Button variant="secondary" size="sm" onClick={() => nudge(-1)} title={t('camera.timeline.prevFrame')}>
            <SkipBack className="w-4 h-4" />
          </Button>
          <Button variant="primary" size="sm" onClick={() => (playing ? stopPlayback() : startPlayback())} disabled={!hasClip}>
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => nudge(1)} title={t('camera.timeline.nextFrame')}>
            <SkipForward className="w-4 h-4" />
          </Button>
          <span className="font-mono text-xs text-bambu-gray shrink-0 tabular-nums">{formatMediaTime(playheadSec)}</span>
          <div className="relative flex-1 min-w-[120px] h-4 flex items-center">
            {!isGap && frameTimes.length > 0 && (
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
            onClick={() => {
              if (selection.kind === 'gap') {
                const s = gapSnaps[currentFrame];
                if (s) downloadSnapshotMutation.mutate(s.id);
              } else if (selectedRecording && clipFrames[currentFrame]) {
                downloadFrameMutation.mutate({ archiveId: selectedRecording.archive_id, seq: clipFrames[currentFrame].seq });
              }
            }}
            title={t('camera.timeline.downloadFrame')}
            className="text-bambu-gray hover:text-white disabled:opacity-50"
            disabled={downloadFramePending || !hasClip}
          >
            {downloadFramePending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageDown className="w-4 h-4" />}
          </button>
          {selection.kind === 'recording' && selectedRecording && (
            <>
              <button
                onClick={() => downloadMutation.mutate(selectedRecording.archive_id)}
                title={t('camera.timeline.download')}
                className="text-bambu-gray hover:text-white disabled:opacity-50"
                disabled={downloadMutation.isPending || !hasClip}
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
            </>
          )}
        </div>
      )}

      {/* Full timeline for the active printer — time rail + boundary ticks (Option C) */}
      <Card className="shrink-0">
        <CardHeader className="flex items-center justify-between text-xs text-bambu-gray" dense>
          <span className="text-white font-medium">{printers.find(p => p.id === activePrinterId)?.name}</span>
          <span>{t('camera.timeline.retentionNote', { days: 7 })}</span>
        </CardHeader>
        <CardContent dense>
          {activeTimeline.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('settings.sentryNoRecordings')}</p>
          ) : (
            // The scroller is this inner div, not the card body, so the legend
            // below stays put instead of sliding off with the strip.
            <div ref={timelineScrollRef} className="overflow-x-auto">
              <div className="min-w-max">
                {/* Boundary rail: a tick + timestamp at the start of each block. */}
                <div className="flex h-5">
                  {activeTimeline.map((b, i) => (
                    <div key={i} style={{ width: blockWidths[i] }} className="relative shrink-0">
                      <div className="absolute left-0 top-3 h-2 w-px bg-bambu-gray-dark" />
                      {blockWidths[i] >= 46 && (
                        <span className="absolute left-1 top-0 text-[9px] font-mono text-bambu-gray whitespace-nowrap">{shortTime(b.start)}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex h-20">
                  {activeTimeline.map((b, i) => {
                    const durMs = b.end - b.start;
                    const widthPx = blockWidths[i];
                    const maxTiles = Math.max(1, Math.min(16, Math.floor(widthPx / 28)));
                    const isJob = b.type === 'job';
                    const inRange = isJob ? [] : activeSnaps.filter(s => s.ms >= b.start && s.ms <= b.end);
                    const title = isJob
                      ? `${jobLabel(b.recording)} — ${formatDuration(durMs / 1000)} — ${b.recording.archive_status ?? b.recording.status} — ${formatFileSize(b.recording.size_bytes)}`
                      : `${t('camera.timeline.standby')} — ${formatDuration(durMs / 1000)} — ${inRange.length} ${t('camera.timeline.snapsLabel')}`;
                    const selected = isJob
                      ? selection?.kind === 'recording' && selection.archiveId === b.recording.archive_id
                      : selection?.kind === 'gap' && selection.start === b.start && selection.end === b.end;
                    return (
                      <FilmstripBlock
                        key={i}
                        printerId={activePrinterId}
                        block={b}
                        snaps={activeSnaps}
                        maxTiles={maxTiles}
                        thickCap
                        jobFooter={isJob ? jobLabel(b.recording) : undefined}
                        gapPill={!isJob ? `${inRange.length} ${t('camera.timeline.snapsLabel')}` : undefined}
                        selected={selected}
                        title={title}
                        onClick={isJob ? () => selectRecording(b.recording) : inRange.length > 0 ? () => selectGap(b.start, b.end) : undefined}
                        style={{ width: widthPx }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {activeTimeline.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-bambu-gray">
              <LegendItem swatch="bg-bambu-green" label={t('camera.timeline.statusRecording')} />
              <LegendItem swatch="bg-blue-600/70" label={t('camera.timeline.statusCompleted')} />
              <LegendItem swatch="bg-yellow-700/80" label={t('camera.timeline.statusCancelled')} />
              <LegendItem swatch="bg-red-900/80" label={t('camera.timeline.statusFailed')} />
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400 ring-1 ring-black/50" />
                {t('camera.timeline.incompleteRecording')}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
