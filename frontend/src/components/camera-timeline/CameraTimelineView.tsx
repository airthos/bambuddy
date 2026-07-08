import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Hls from 'hls.js';
import { Download, Loader2, Pause, Play, SkipBack, SkipForward, Star, Trash2 } from 'lucide-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { formatDuration, formatMediaTime, parseUTCDate } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import { api, getStreamToken } from '../../api/client';
import type { CameraRecordingSummary, Printer } from '../../api/client';

// Swaps in the *current* stream token on every request hls.js makes (playlist
// polls for a still-growing recording, and every segment fetch) -- the token
// baked into the initial playlist/segment URLs can go stale for a long-running
// live-watch session, and hls.js's own requests bypass the app's normal
// Authorization-header auth entirely (same reason frame <img> tags need this).
function withFreshToken(url: string): string {
  const token = getStreamToken();
  if (!token) return url;
  const withoutToken = url.replace(/([?&])token=[^&]*(&|$)/, (_m, pre, post) => (post === '&' ? pre : pre === '?' ? '' : ''));
  const sep = withoutToken.includes('?') ? '&' : '?';
  return `${withoutToken}${sep}token=${encodeURIComponent(token)}`;
}

interface CameraTimelineViewProps {
  printers: Printer[];
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

// rate is what actually matters for video mode: it's a multiplier on
// playbackRate, and since segments already encode each frame's *real*
// captured duration (variable frame rate, not a fixed fps), rate: 1 already
// reproduces true real-time elapsed playback exactly, regardless of the
// P1S's actual (inconsistent, sub-1fps) capture cadence -- no extra
// handling needed. fps is the JPEG-mode (pre-video-ready) frame-stepping
// interval, AND (see MAX_NATIVE_PLAYBACK_RATE below) the manual seek-stepping
// interval video mode falls back to above the safe native rate.
const SPEEDS = [
  { key: 'half', fps: 1, rate: 0.5 },
  { key: 'normal', fps: 2, rate: 1 },
  { key: 'double', fps: 4, rate: 2 },
  { key: 'fiveX', fps: 10, rate: 5 },
  { key: 'twentyX', fps: 30, rate: 20 },
  { key: 'fiftyX', fps: 60, rate: 50 },
] as const;

// HTML5 video.playbackRate reliably crashes playback above ~4x (see commit
// 60e1b3fe). Rates at or below this use native playbackRate; anything
// higher falls back to manually stepping video.currentTime through
// frameTimes on a timer instead (cheap and exact here since every frame is
// its own keyframe -- see camera_hls.py's all-intra encoding).
const MAX_NATIVE_PLAYBACK_RATE = 4;

// The backend sends naive UTC timestamps with no 'Z'/offset (e.g.
// "2026-07-07T17:27:59") -- plain `new Date(...)` parses that as *local*
// time, not UTC. On a browser whose local zone isn't UTC, that silently
// shifted every "elapsed"/"duration" readout on this page by the local UTC
// offset (a several-hour-long print could read as a few minutes in).
// parseUTCDate is the same fix already used elsewhere in the app for this
// exact backend behavior -- see utils/date.ts.
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

export function CameraTimelineView({ printers }: CameraTimelineViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activePrinterId, setActivePrinterId] = useState<number>(printers[0]?.id ?? 0);
  const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedKey, setSpeedKey] = useState<(typeof SPEEDS)[number]['key']>('normal');
  const speed = SPEEDS.find(s => s.key === speedKey) ?? SPEEDS[0];
  const fps = speed.fps;
  const useNativeRate = speed.rate <= MAX_NATIVE_PLAYBACK_RATE;
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

  const activeRecordings = recordingsByPrinter.get(activePrinterId) ?? [];
  const activeTimeline = useMemo(() => buildTimeline(activeRecordings), [activeRecordings]);
  const selectedRecording = activeRecordings.find(r => r.archive_id === selectedArchiveId) ?? null;

  // "Jump to live" used to mean "seek the growing HLS video to whatever's
  // buffered so far" -- fragile, since the live edge of a still-transcoding
  // playlist moves and buffers unevenly. Showing the same raw live camera
  // stream the grid/camera view already uses is trivially reliable by
  // comparison: no seeking, no buffering wait, just the live feed.
  const showLiveImage = liveFollow && selectedRecording?.status === 'recording';

  const { data: frameList } = useQuery({
    queryKey: ['recording-frames', activePrinterId, selectedArchiveId],
    queryFn: () => api.getRecordingFrames(activePrinterId, selectedArchiveId as number),
    enabled: selectedArchiveId != null,
    refetchInterval: selectedRecording?.status === 'recording' ? 2000 : false,
  });
  const maxFrame = frameList && frameList.length > 0 ? frameList.length - 1 : 0;

  // Once a recording has at least one HLS segment, play it as a real video —
  // native decode/buffering/seeking instead of fetching individual JPEGs
  // (which never cached or scrubbed smoothly no matter how much preloading
  // was thrown at it). Still falls back to the JPEG viewer below until the
  // first segment exists (segments land ~20s after enough frames accumulate,
  // see camera_hls.py), and for any recording whose encode failed.
  const useVideo = selectedRecording?.video_status === 'ready';
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Set right before a *programmatic* pause() call that shouldn't clear
  // `playing` (e.g. switching from native to manual-seek-stepped playback
  // when the user bumps the speed past MAX_NATIVE_PLAYBACK_RATE mid-play) --
  // the video's onPause fires either way, but here it's not the user
  // stopping playback, just a handoff between two playback mechanisms.
  const suppressPauseEventRef = useRef(false);

  // Maps frame index -> seconds into the stitched HLS timeline. Frame i's
  // start time in the concatenated segments is exactly the cumulative sum of
  // every earlier frame's real captured duration, i.e. (ts_ms[i] - ts_ms[0]) —
  // camera_hls.py builds each segment's per-frame durations from these same
  // consecutive ts_ms deltas, so this lines up with the actual video exactly.
  const frameTimes = useMemo(() => {
    if (!frameList || frameList.length === 0) return [];
    const t0 = frameList[0].ts_ms;
    return frameList.map(f => (f.ts_ms - t0) / 1000);
  }, [frameList]);

  // Preload every frame into the browser's HTTP cache as soon as a recording
  // is selected. Without this, the first playthrough visibly flickers/stalls
  // because <img src> only starts fetching a frame the instant playback
  // reaches it — a second playthrough is smooth only because everything's
  // already cached by then. Firing all the requests up front (the browser
  // queues them respecting its own per-host connection limit) gets that
  // same smoothness on the very first play. Not needed once video is ready —
  // there are no individual frame JPEGs to preload for that path.
  useEffect(() => {
    if (useVideo || !frameList || selectedArchiveId == null) return;
    let cancelled = false;
    for (const f of frameList) {
      if (cancelled) break;
      const img = new Image();
      img.src = api.getRecordingFrameUrl(activePrinterId, selectedArchiveId, f.seq);
    }
    return () => {
      cancelled = true;
    };
  }, [useVideo, frameList, selectedArchiveId, activePrinterId]);

  // Follow the newest frame while liveFollow is on and the session is still recording.
  // Video mode has its own live-edge handling (see the durationchange effect below).
  useEffect(() => {
    if (!useVideo && liveFollow && selectedRecording?.status === 'recording' && frameList) {
      setCurrentFrame(frameList.length > 0 ? frameList.length - 1 : 0);
    }
  }, [useVideo, frameList, liveFollow, selectedRecording?.status]);

  // Playback loop — JPEG mode always, and video mode too once the selected
  // speed exceeds MAX_NATIVE_PLAYBACK_RATE (native playbackRate crashes
  // above that -- see the Play button below and 60e1b3fe). Manually
  // stepping video.currentTime here works at any speed because every frame
  // is its own keyframe (all-intra encoding), so each "seek" is instant.
  useEffect(() => {
    if ((useVideo && useNativeRate) || !playing || !frameList || frameList.length === 0) return;
    const id = setInterval(() => {
      setCurrentFrame(f => {
        if (f >= maxFrame) {
          setPlaying(false);
          return f;
        }
        const next = f + 1;
        if (useVideo && videoRef.current && frameTimes[next] != null) {
          videoRef.current.currentTime = frameTimes[next];
        }
        return next;
      });
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [useVideo, useNativeRate, playing, fps, frameList, maxFrame, frameTimes]);

  // Sets up hls.js (or native Safari HLS) against the playlist whenever a
  // video-ready recording is selected, and tears it down on change/unmount.
  useEffect(() => {
    if (!useVideo || !selectedRecording || !videoRef.current) return;
    const video = videoRef.current;
    const url = api.getRecordingPlaylistUrl(activePrinterId, selectedRecording.archive_id);

    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: (xhr, requestUrl) => {
          xhr.open('GET', withFreshToken(requestUrl), true);
        },
        // Buffer the *entire* recording eagerly on selection, not just N
        // seconds ahead -- seeking into a not-yet-buffered spot ("buffering
        // forever") is what happens when the fetch-on-demand path doesn't
        // keep up; buffering everything up front sidesteps that class of
        // bug outright, and hls.js already fills forward from wherever the
        // playhead currently is, so this also naturally prioritizes
        // whatever's closest to the current position. Bounded by
        // maxBufferSize (segments are small post-halved-resolution, so even
        // a multi-hour recording comfortably fits under this).
        maxBufferLength: Infinity,
        maxMaxBufferLength: Infinity,
        maxBufferSize: 1000 * 1000 * 1000,
        liveSyncDurationCount: 1,
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        console.error(`[sentry-hls] fatal ${data.type}: ${data.details}`);
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hlsRef.current = hls;
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
    // Safari: native HLS support, no library needed.
    video.src = url;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
    // selectedRecording is a *new object* every time recordingQueries
    // refetches (every 5s) even when nothing meaningful changed -- depending
    // on it directly tore the whole hls.js instance down and rebuilt it
    // every 5 seconds, which is what was resetting playback to the start.
    // archive_id is the only thing that actually needs to trigger a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useVideo, selectedArchiveId, activePrinterId]);

  // Keeps the frame-index display (scrub label, prev/next) in sync while the
  // video plays under its own steam. Also tracks the raw currentTime, for
  // the "buffered ahead" readout below (frame granularity is too coarse for
  // that -- frames land 30-45s apart, currentTime is continuous).
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  useEffect(() => {
    if (!useVideo || !videoRef.current || frameTimes.length === 0) return;
    const video = videoRef.current;
    function onTimeUpdate(e: Event) {
      // While a seek is in flight, currentTime can still briefly reflect
      // the *old* position (the browser hasn't finished decoding to the
      // new spot yet) -- syncing off of that stale value is exactly what
      // made the scrub bar visibly snap back to where it just was. Wait
      // for the 'seeked' event below instead.
      if (video.seeking) {
        console.log(`[sentry-seek] ${e.type} ignored (seeking), currentTime=${video.currentTime}`);
        return;
      }
      const t = video.currentTime;
      console.log(`[sentry-seek] ${e.type}: currentTime=${t}`);
      setCurrentTimeSec(t);
      let idx = 0;
      for (let i = 0; i < frameTimes.length; i++) {
        if (frameTimes[i] <= t) idx = i;
        else break;
      }
      setCurrentFrame(idx);
    }
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onTimeUpdate);
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeked', onTimeUpdate);
    };
  }, [useVideo, frameTimes]);

  // Buffering spinner: native <video> fires 'waiting' when playback stalls
  // because it's run out of buffered data, and 'playing' once it resumes --
  // exactly the "is it healthy right now" signal the buffered-ahead number
  // alone doesn't convey (that number can be healthy while still stalled on
  // a slow-to-decode frame). This alone isn't fully reliable, though -- see
  // the stall watchdog below -- so isBuffering is also driven from there.
  const [isBuffering, setIsBuffering] = useState(false);
  useEffect(() => {
    if (!useVideo || !videoRef.current) return;
    const video = videoRef.current;
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onPlaying);
    return () => {
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onPlaying);
    };
  }, [useVideo, selectedArchiveId]);

  // Tracks *every* buffered range, not just the outermost one, for the
  // buffering bar below and for jump-to-live -- video.duration is Infinity
  // for a still-growing (PLAYLIST-TYPE:EVENT, no #EXT-X-ENDLIST) playlist,
  // so it can never be used to find "the live edge". Taking only
  // buffered.end(buffered.length - 1) here was actively misleading: MSE can
  // (and does) end up with disjoint ranges -- e.g. [0, 120] and [125, 400] --
  // and that approach reports the whole span as "buffered" even though
  // there's a real hole at 120-125 that playback can stall dead in.
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>([]);
  useEffect(() => {
    if (!useVideo || !videoRef.current) return;
    const video = videoRef.current;
    function onProgress() {
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
      }
      setBufferedRanges(ranges);
    }
    video.addEventListener('progress', onProgress);
    video.addEventListener('loadedmetadata', onProgress);
    onProgress();
    return () => {
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('loadedmetadata', onProgress);
    };
  }, [useVideo, selectedArchiveId]);
  const bufferedEnd = bufferedRanges.length > 0 ? bufferedRanges[bufferedRanges.length - 1].end : 0;

  // Stall watchdog: recovers from playback silently sticking on one frame
  // even though `buffered` claims the area is covered. This happens at
  // small gaps between segments (or an occasional stuck decode) that don't
  // reliably fire the video element's own 'waiting' event -- exactly what
  // manually seeking a bit further along was already working around by
  // hand. Detects "currentTime hasn't moved in ~2s while it should be
  // playing" and either jumps straight to the next known-buffered range (a
  // real gap) or nudges forward with escalating small seeks (a stuck
  // decode inside an already-buffered range) -- either way, this is exactly
  // what a manual nearby seek was already doing, just automatic.
  const stallRef = useRef({ time: 0, count: 0, attempts: 0 });
  useEffect(() => {
    if (!useVideo || !useNativeRate || !playing || !videoRef.current) return;
    const video = videoRef.current;
    stallRef.current = { time: video.currentTime, count: 0, attempts: 0 };
    const id = setInterval(() => {
      if (video.paused || video.seeking) return;
      const t = video.currentTime;
      if (Math.abs(t - stallRef.current.time) > 0.05) {
        stallRef.current = { time: t, count: 0, attempts: 0 };
        return;
      }
      stallRef.current.count += 1;
      if (stallRef.current.count < 2) return;
      if (stallRef.current.attempts >= 15) return; // stop auto-correcting; spinner stays up for a manual seek

      setIsBuffering(true);
      let nextStart: number | null = null;
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        if (start > t + 0.05 && (nextStart === null || start < nextStart)) nextStart = start;
      }
      const target =
        nextStart !== null && nextStart - t < 30
          ? nextStart + 0.05
          : t + Math.min(5, 0.25 * 2 ** (stallRef.current.count - 2));
      console.log(`[sentry-stall] stuck at ${t.toFixed(2)}, nudging to ${target.toFixed(2)}`);
      video.currentTime = target;
      stallRef.current = { time: target, count: 0, attempts: stallRef.current.attempts + 1 };
    }, 1000);
    return () => clearInterval(id);
  }, [useVideo, useNativeRate, playing, selectedArchiveId]);

  // Jump-to-live: a ONE-SHOT seek to whatever's buffered so far, the moment
  // liveFollow is turned on (landing on a live recording, or clicking "Jump
  // to Live"). This must not re-fire on every later bufferedEnd change --
  // native <video> playback already advances and catches up on its own as
  // more segments buffer in; re-seeking on every buffer tick fought that
  // continuously, which looked like "won't pause and jumps all around"
  // (pause just stops the play head advancing on its own -- it doesn't stop
  // this effect from yanking currentTime forward on the next tick).
  const hasJumpedToLiveRef = useRef(false);
  useEffect(() => {
    if (!liveFollow) return;
    hasJumpedToLiveRef.current = false;
  }, [liveFollow, selectedArchiveId]);
  useEffect(() => {
    if (!useVideo || !liveFollow || !videoRef.current || bufferedEnd <= 0 || hasJumpedToLiveRef.current) return;
    console.log(`[sentry-seek] jump-to-live effect: ${videoRef.current.currentTime} -> ${bufferedEnd}`);
    videoRef.current.currentTime = bufferedEnd;
    videoRef.current.play().catch(() => {});
    hasJumpedToLiveRef.current = true;
  }, [useVideo, liveFollow, bufferedEnd]);

  useEffect(() => {
    if (useVideo && videoRef.current && useNativeRate) videoRef.current.playbackRate = speed.rate;
  }, [useVideo, speed, useNativeRate]);

  // Speeds above MAX_NATIVE_PLAYBACK_RATE are driven entirely by the manual
  // seek-stepping loop above, not the video element's own playback -- make
  // sure it's actually paused when switching into that mode (e.g. the user
  // was playing natively at 2x and jumps straight to 50x), otherwise the
  // video would keep advancing on its own *in addition to* being seeked
  // every tick.
  useEffect(() => {
    if (useVideo && videoRef.current && !useNativeRate && !videoRef.current.paused) {
      suppressPauseEventRef.current = true;
      videoRef.current.pause();
    }
  }, [useVideo, useNativeRate]);

  const keepForeverMutation = useMutation({
    mutationFn: ({ archiveId, keep }: { archiveId: number; keep: boolean }) =>
      api.setRecordingKeepForever(activePrinterId, archiveId, keep),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] }),
  });
  const downloadMutation = useMutation({
    mutationFn: (archiveId: number) => api.downloadRecording(activePrinterId, archiveId),
  });
  const deleteMutation = useMutation({
    mutationFn: (archiveId: number) => api.deleteRecording(activePrinterId, archiveId),
    onSuccess: (_data, archiveId) => {
      queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] });
      if (selectedArchiveId === archiveId) {
        setSelectedArchiveId(null);
        setPlaying(false);
      }
    },
  });

  function selectRecording(r: CameraRecordingSummary) {
    setPlaying(false);
    setSelectedArchiveId(r.archive_id);
    const live = r.status === 'recording';
    setLiveFollow(live);
    setCurrentFrame(0); // corrected to the last frame once frameList loads, if live
  }

  function seekToFrame(idx: number) {
    const clamped = Math.max(0, Math.min(maxFrame, idx));
    setCurrentFrame(clamped);
    if (useVideo && videoRef.current && frameTimes[clamped] != null) {
      console.log(`[sentry-seek] seekToFrame(${idx}): ${videoRef.current.currentTime} -> ${frameTimes[clamped]}`);
      videoRef.current.currentTime = frameTimes[clamped];
    }
  }

  function nudge(delta: number) {
    if (!frameList || frameList.length === 0) return;
    setPlaying(false);
    setLiveFollow(false);
    if (useVideo && videoRef.current) videoRef.current.pause();
    seekToFrame(currentFrame + delta);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selectedArchiveId) return;
      if (e.key === 'ArrowLeft') nudge(-1);
      if (e.key === 'ArrowRight') nudge(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArchiveId, frameList]);

  const now = Date.now();
  const dayAgo = now - 24 * 3600000;
  const currentSeq = frameList?.[currentFrame]?.seq;
  const currentTsMs = frameList?.[currentFrame]?.ts_ms;

  // Playhead/remaining readout, YouTube-style (elapsed on the left of the
  // scrub bar, remaining on the right). frameTimes[last] is the *start* of
  // the final frame, not the true end of the video (that frame also has its
  // own captured duration) -- close enough for a still-growing recording
  // where "total" is a moving target anyway.
  const playheadSec = useVideo ? currentTimeSec : (frameTimes[currentFrame] ?? 0);
  const totalSec = frameTimes.length > 0 ? frameTimes[frameTimes.length - 1] : 0;
  const remainingSec = Math.max(0, totalSec - playheadSec);

  // Double-buffer the visible frame: only swap the <img> src once the new
  // frame has actually finished loading, instead of binding src directly to
  // currentSeq. Binding directly still flickers/blanks on a cache miss (or a
  // decode that hasn't resolved yet) because the browser shows nothing (or a
  // broken-image icon) between the old src being replaced and the new one
  // becoming visible. This way the previous frame stays on screen the entire
  // time — visible only updates on a confirmed load, so a slow/uncached
  // frame just holds the last good frame a little longer instead of blanking.
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  useEffect(() => {
    setDisplayUrl(null); // don't show the previous recording's last frame while the new one loads
    setBufferedRanges([]);
    setCurrentTimeSec(0);
    setIsBuffering(false);
  }, [selectedArchiveId]);
  useEffect(() => {
    if (useVideo || !selectedRecording || currentSeq == null) return;
    const url = api.getRecordingFrameUrl(activePrinterId, selectedRecording.archive_id, currentSeq);
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setDisplayUrl(url);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [useVideo, activePrinterId, selectedRecording, currentSeq]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Printer strip — basic 24h preview per printer: raw (time-proportional) + events (one tick per job) */}
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
              <div className="flex h-3 rounded overflow-hidden bg-bambu-dark-tertiary" title={t('camera.timeline.rawTimeline')}>
                {blocks.map((b, i) => {
                  const clampedStart = Math.max(b.start, dayAgo);
                  const width = ((b.end - clampedStart) / (now - dayAgo)) * 100;
                  const cls = b.type === 'gap' ? 'bg-bambu-dark-tertiary' : jobClass(b.recording);
                  return <div key={i} style={{ width: `${width}%` }} className={cls} />;
                })}
              </div>
              <div className="flex justify-between text-[10px] text-bambu-gray mt-1 mb-1.5">
                <span>{t('camera.timeline.hoursAgo', { count: 24 })}</span>
                <span>{t('camera.timeline.now')}</span>
              </div>
              {/* Events row — one equally-spaced tick per job, ignoring idle gap duration */}
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

      {/* Viewport + stats overlay. min-h-0 is the key rule here: flex items
          default to min-height:auto, which for a box containing an <img>
          resolves to the image's *intrinsic* size — that default silently
          overrides flex-shrink/overflow-hidden and is exactly what let a
          loaded frame grow the box past the viewport (invisible with no
          image loaded, since the placeholder text is short — only showed up
          once a real frame rendered). min-h-0 overrides that default so
          flex-1 can size this box to exactly the remaining space, no more
          and no less — a viewport-relative max-h cap isn't needed and was
          leaving dead space whenever the real remaining space was smaller. */}
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
                label={selectedRecording.status === 'recording' ? t('camera.timeline.stats.elapsed') : t('camera.timeline.stats.duration')}
                value={formatDuration((recordingEnd(selectedRecording) - recordingStart(selectedRecording)) / 1000)}
              />
              <StatRow label={t('settings.sentryFrames')} value={String(selectedRecording.frame_count)} />
              <span className={`inline-block mt-2 px-2 py-0.5 rounded text-[10px] font-semibold ${jobClass(selectedRecording)}`}>
                {(selectedRecording.archive_status ?? selectedRecording.status).toUpperCase()}
              </span>
            </div>

            {selectedRecording.status === 'recording' && !liveFollow && (
              <Button
                variant="primary"
                size="sm"
                className="absolute top-3 right-3 z-10"
                onClick={() => setLiveFollow(true)}
              >
                {t('camera.timeline.jumpToLive')}
              </Button>
            )}

            {/* Video/frame element always mounted (so HLS keeps buffering near the
                live edge in the background) -- the live raw stream just overlays
                on top of it while showLiveImage is on, instead of tearing
                anything down. */}
            {useVideo && (
              <video
                ref={videoRef}
                className={`w-full h-full object-contain ${showLiveImage ? 'hidden' : ''}`}
                muted
                playsInline
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  if (suppressPauseEventRef.current) {
                    suppressPauseEventRef.current = false;
                    return;
                  }
                  setPlaying(false);
                }}
                onEnded={() => setPlaying(false)}
              />
            )}
            {showLiveImage ? (
              <img
                src={api.getCameraStreamUrl(activePrinterId, 15)}
                alt=""
                className="w-full h-full object-contain"
              />
            ) : useVideo ? (
              isBuffering && (
                <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/40 pointer-events-none">
                  <div className="flex items-center gap-2 bg-bambu-dark/90 text-white text-xs px-3 py-1.5 rounded-full">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('camera.timeline.buffering')}
                  </div>
                </div>
              )
            ) : !frameList || frameList.length === 0 ? (
              <p className="text-bambu-gray text-sm">{t('settings.sentryNoRecordings')}</p>
            ) : displayUrl ? (
              <img src={displayUrl} alt="" className="w-full h-full object-contain" decoding="async" />
            ) : (
              <p className="text-bambu-gray text-sm">{t('common.loading')}</p>
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
            onClick={() => {
              setLiveFollow(false); // manual play/pause always exits auto-follow-live
              if (useVideo && useNativeRate && videoRef.current) {
                const v = videoRef.current;
                if (v.paused) {
                  if (currentFrame >= maxFrame) {
                    seekToFrame(0);
                  }
                  v.play();
                } else {
                  v.pause();
                }
                return;
              }
              // JPEG mode, or video mode above MAX_NATIVE_PLAYBACK_RATE: the
              // manual seek-stepping loop (above) drives playback instead of
              // the video element's own play()/pause().
              if (!playing && currentFrame >= maxFrame) {
                setCurrentFrame(0);
              }
              setPlaying(p => !p);
            }}
            disabled={!frameList || frameList.length === 0}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => nudge(1)} title={t('camera.timeline.nextFrame')}>
            <SkipForward className="w-4 h-4" />
          </Button>
          <span className="font-mono text-xs text-bambu-gray shrink-0 tabular-nums">{formatMediaTime(playheadSec)}</span>
          <div className="relative flex-1 min-w-[120px] h-4 flex items-center">
            {useVideo && frameTimes.length > 0 && (
              // Sits directly behind the range input's own (transparent)
              // track, YouTube-style: light-gray = downloaded/buffered,
              // dark = not yet fetched. The green "played" portion up to the
              // thumb is the browser's own accent-color fill on the input.
              // Drawn from every disjoint buffered range, not just the
              // outermost one -- a single bar to bufferedEnd would paint
              // real gaps as "buffered" too.
              <div className="absolute left-0 h-1 w-full rounded-full bg-bambu-dark-tertiary overflow-hidden pointer-events-none">
                {bufferedRanges.map((r, i) => {
                  const total = frameTimes[frameTimes.length - 1] || 1;
                  const left = Math.min(100, (r.start / total) * 100);
                  const width = Math.min(100 - left, ((r.end - r.start) / total) * 100);
                  return (
                    <div
                      key={i}
                      className="absolute h-full bg-bambu-gray-dark/70"
                      style={{ left: `${left}%`, width: `${width}%` }}
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
                // Dragging the scrub bar seeks -- it should not stop
                // playback (a paused player that's already stopped just
                // stays stopped; a playing one keeps playing from the new
                // position, same as YouTube's scrub bar).
                setLiveFollow(false);
                seekToFrame(Number(e.target.value));
              }}
              className="relative w-full h-1 appearance-none bg-transparent cursor-pointer accent-bambu-green [&::-webkit-slider-runnable-track]:bg-transparent [&::-moz-range-track]:bg-transparent"
            />
          </div>
          <span className="font-mono text-xs text-bambu-gray shrink-0 tabular-nums">-{formatMediaTime(remainingSec)}</span>
          <div className="flex gap-1">
            {SPEEDS.map(s => (
              <button
                key={s.key}
                onClick={() => setSpeedKey(s.key)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  speedKey === s.key ? 'bg-bambu-green text-white' : 'bg-bambu-dark-tertiary text-bambu-gray hover:text-white'
                }`}
              >
                {t(`camera.timeline.speed.${s.key}`)}
              </button>
            ))}
          </div>
          <button
            onClick={() => downloadMutation.mutate(selectedRecording.archive_id)}
            title={t('camera.timeline.download')}
            className="text-bambu-gray hover:text-white disabled:opacity-50"
            disabled={!useVideo || downloadMutation.isPending}
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
            disabled={selectedRecording.status === 'recording'}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Full timeline for the active printer — raw/time-proportional, the detailed counterpart to the events row above */}
      <Card className="shrink-0">
        <CardHeader className="flex items-center justify-between text-xs text-bambu-gray" dense>
          <span className="text-white font-medium">{printers.find(p => p.id === activePrinterId)?.name}</span>
          <span>{t('camera.timeline.retentionNote', { days: 7 })}</span>
        </CardHeader>
        <CardContent className="overflow-x-auto" dense>
          {activeTimeline.length === 0 ? (
            <p className="text-sm text-bambu-gray">{t('settings.sentryNoRecordings')}</p>
          ) : (
            <div className="flex h-12 min-w-max">
              {activeTimeline.map((b, i) => {
                const durMs = b.end - b.start;
                const widthPx = Math.max(32, Math.min(260, (durMs / 3600000) * 34));
                if (b.type === 'gap') {
                  return (
                    <div
                      key={i}
                      style={{ width: widthPx }}
                      title={`${t('camera.timeline.idle')} — ${formatDuration(durMs / 1000)}`}
                      className="shrink-0 border-r border-bambu-dark bg-bambu-dark-tertiary text-bambu-gray flex items-center justify-center text-[10px] px-1 truncate"
                    >
                      {formatDuration(durMs / 1000)}
                    </div>
                  );
                }
                return (
                  <button
                    key={i}
                    onClick={() => selectRecording(b.recording)}
                    title={`${b.recording.file ?? ''} — ${formatDuration(durMs / 1000)} — ${b.recording.archive_status ?? b.recording.status} — ${formatFileSize(b.recording.size_bytes)}`}
                    style={{ width: widthPx }}
                    className={`shrink-0 border-r border-bambu-dark flex items-center justify-center text-[10px] px-1 truncate cursor-pointer ${jobClass(b.recording)} ${
                      selectedArchiveId === b.recording.archive_id ? 'ring-2 ring-white ring-inset' : ''
                    }`}
                  >
                    {formatDuration(durMs / 1000)}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
