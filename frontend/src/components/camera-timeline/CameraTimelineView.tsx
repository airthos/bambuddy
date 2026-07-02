import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, SkipBack, SkipForward, Star, Trash2 } from 'lucide-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { formatDuration } from '../../utils/date';
import { formatFileSize } from '../../utils/file';
import { api } from '../../api/client';
import type { CameraRecordingSummary, Printer } from '../../api/client';

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

const SPEEDS = [
  { key: 'slow', fps: 2 },
  { key: 'normal', fps: 10 },
  { key: 'fast', fps: 30 },
  { key: 'veryFast', fps: 60 },
] as const;

function recordingStart(r: CameraRecordingSummary): number {
  return r.started_at ? new Date(r.started_at).getTime() : Date.now();
}
function recordingEnd(r: CameraRecordingSummary): number {
  if (r.stopped_at) return new Date(r.stopped_at).getTime();
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
  const [fps, setFps] = useState<number>(10);
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

  const { data: frameList } = useQuery({
    queryKey: ['recording-frames', activePrinterId, selectedArchiveId],
    queryFn: () => api.getRecordingFrames(activePrinterId, selectedArchiveId as number),
    enabled: selectedArchiveId != null,
    refetchInterval: selectedRecording?.status === 'recording' ? 2000 : false,
  });
  const maxFrame = frameList && frameList.length > 0 ? frameList.length - 1 : 0;

  // Follow the newest frame while liveFollow is on and the session is still recording.
  useEffect(() => {
    if (liveFollow && selectedRecording?.status === 'recording' && frameList) {
      setCurrentFrame(frameList.length > 0 ? frameList.length - 1 : 0);
    }
  }, [frameList, liveFollow, selectedRecording]);

  // Playback loop
  useEffect(() => {
    if (!playing || !frameList || frameList.length === 0) return;
    const id = setInterval(() => {
      setCurrentFrame(f => {
        if (f >= maxFrame) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [playing, fps, frameList, maxFrame]);

  const keepForeverMutation = useMutation({
    mutationFn: ({ archiveId, keep }: { archiveId: number; keep: boolean }) =>
      api.setRecordingKeepForever(activePrinterId, archiveId, keep),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['recordings', activePrinterId] }),
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

  function nudge(delta: number) {
    if (!frameList || frameList.length === 0) return;
    setPlaying(false);
    setLiveFollow(false);
    setCurrentFrame(f => Math.max(0, Math.min(maxFrame, f + delta)));
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

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {/* Printer strip — basic 24h preview per printer */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        {printers.map(p => {
          const recs = (recordingsByPrinter.get(p.id) ?? []).filter(r => recordingEnd(r) > dayAgo);
          const isLive = recs.some(r => r.status === 'recording');
          const blocks = buildTimeline(recs);
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
              <div className="flex h-3 rounded overflow-hidden bg-bambu-dark-tertiary">
                {blocks.map((b, i) => {
                  const clampedStart = Math.max(b.start, dayAgo);
                  const width = ((b.end - clampedStart) / (now - dayAgo)) * 100;
                  const cls = b.type === 'gap' ? 'bg-bambu-dark-tertiary' : jobClass(b.recording);
                  return <div key={i} style={{ width: `${width}%` }} className={cls} />;
                })}
              </div>
              <div className="flex justify-between text-[10px] text-bambu-gray mt-1">
                <span>{t('camera.timeline.hoursAgo', { count: 24 })}</span>
                <span>{t('camera.timeline.now')}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Viewport + stats overlay */}
      <Card className="relative flex-1 min-h-[340px] flex items-center justify-center overflow-hidden">
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
                value={selectedRecording.started_at ? new Date(selectedRecording.started_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
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

            {!frameList || frameList.length === 0 ? (
              <p className="text-bambu-gray text-sm">{t('settings.sentryNoRecordings')}</p>
            ) : (
              <img
                key={`${selectedArchiveId}-${currentSeq}`}
                src={api.getRecordingFrameUrl(activePrinterId, selectedRecording.archive_id, currentSeq ?? 0)}
                alt=""
                className="max-h-full max-w-full object-contain"
              />
            )}
            {currentTsMs != null && (
              <span className="absolute bottom-3 left-3 text-xs text-white bg-bambu-dark/80 px-2 py-1 rounded">
                {new Date(currentTsMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                {liveFollow && <span className="text-bambu-green ml-2">{t('camera.timeline.live')}</span>}
              </span>
            )}
          </>
        )}
      </Card>

      {/* Playback controls */}
      {selectedRecording && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => nudge(-1)} title={t('camera.timeline.prevFrame')}>
            <SkipBack className="w-4 h-4" />
          </Button>
          <Button variant="primary" size="sm" onClick={() => setPlaying(p => !p)} disabled={!frameList || frameList.length === 0}>
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => nudge(1)} title={t('camera.timeline.nextFrame')}>
            <SkipForward className="w-4 h-4" />
          </Button>
          <input
            type="range"
            min={0}
            max={maxFrame}
            value={currentFrame}
            onChange={e => { setPlaying(false); setLiveFollow(false); setCurrentFrame(Number(e.target.value)); }}
            className="flex-1 min-w-[120px] accent-bambu-green"
          />
          <span className="text-xs text-bambu-gray w-24 text-right shrink-0">{currentFrame} / {maxFrame}</span>
          <div className="flex gap-1">
            {SPEEDS.map(s => (
              <button
                key={s.key}
                onClick={() => setFps(s.fps)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  fps === s.fps ? 'bg-bambu-green text-white' : 'bg-bambu-dark-tertiary text-bambu-gray hover:text-white'
                }`}
              >
                {t(`camera.timeline.speed.${s.key}`)}
              </button>
            ))}
          </div>
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

      {/* Full timeline for the active printer */}
      <Card>
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
