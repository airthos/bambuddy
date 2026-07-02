import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RefreshCw, AlertTriangle, WifiOff, ZoomIn, ZoomOut, Fullscreen, Minimize, Stethoscope } from 'lucide-react';
import { api, getAuthToken, withStreamToken } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { ChamberLight } from './icons/ChamberLight';
import { SkipObjectsModal, SkipObjectsIcon } from './SkipObjectsModal';
import { CameraDiagnoseModal } from './CameraDiagnoseModal';

interface CameraGridTileProps {
  printerId: number;
  printerName: string;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;
const STALL_CHECK_INTERVAL = 5000;

// Grid-cell variant of EmbeddedCameraViewer — same header controls, video area,
// zoom/pan handling, and stream lifecycle, minus the floating/drag/resize/minimize
// chrome (the tile's size and position are owned by the grid, not localStorage).
export function CameraGridTile({ printerId, printerName }: CameraGridTileProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [lastTouchDistance, setLastTouchDistance] = useState<number | null>(null);
  const [lastTouchCenter, setLastTouchCenter] = useState<{ x: number; y: number } | null>(null);

  // Stream state
  const [streamError, setStreamError] = useState(false);
  const [streamLoading, setStreamLoading] = useState(true);
  const [imageKey, setImageKey] = useState(Date.now());
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectCountdown, setReconnectCountdown] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const stallCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [showSkipObjectsModal, setShowSkipObjectsModal] = useState(false);
  const [showDiagnoseModal, setShowDiagnoseModal] = useState(false);

  // Fetch printer info
  const { data: printer } = useQuery({
    queryKey: ['printer', printerId],
    queryFn: () => api.getPrinter(printerId),
    enabled: printerId > 0,
  });

  // Fetch printer status for light toggle and skip objects
  const { data: status } = useQuery({
    queryKey: ['printerStatus', printerId],
    queryFn: () => api.getPrinterStatus(printerId),
    refetchInterval: 30000,
    enabled: printerId > 0,
  });

  // Chamber light mutation with optimistic update
  const chamberLightMutation = useMutation({
    mutationFn: (on: boolean) => api.setChamberLight(printerId, on),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: ['printerStatus', printerId] });
      const previousStatus = queryClient.getQueryData(['printerStatus', printerId]);
      queryClient.setQueryData(['printerStatus', printerId], (old: typeof status) => ({
        ...old,
        chamber_light: on,
      }));
      return { previousStatus };
    },
    onSuccess: (_, on) => {
      showToast(`Chamber light ${on ? 'on' : 'off'}`);
    },
    onError: (error: Error, _, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['printerStatus', printerId], context.previousStatus);
      }
      showToast(error.message || t('printers.toast.failedToControlChamberLight'), 'error');
    },
  });

  const isPrintingWithObjects = (status?.state === 'RUNNING' || status?.state === 'PAUSE') && (status?.printable_objects_count ?? 0) >= 2;

  // Cleanup on unmount - stop the camera stream (leaving the grid, or the grid
  // itself unmounting, both trigger this the same way React unmount always does)
  const stopSentRef = useRef(false);
  useEffect(() => {
    stopSentRef.current = false;
    const stopUrl = `/api/v1/printers/${printerId}/camera/stop`;

    const sendStopOnce = () => {
      if (printerId > 0 && !stopSentRef.current) {
        stopSentRef.current = true;
        const headers: Record<string, string> = {};
        const token = getAuthToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        fetch(stopUrl, { method: 'POST', keepalive: true, headers }).catch(() => {});
      }
    };

    const imgElement = imgRef.current;

    return () => {
      if (imgElement) {
        imgElement.src = '';
      }
      sendStopOnce();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (stallCheckIntervalRef.current) clearInterval(stallCheckIntervalRef.current);
    };
  }, [printerId]);

  // Auto-hide loading after timeout
  useEffect(() => {
    if (streamLoading) {
      const timer = setTimeout(() => setStreamLoading(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [streamLoading, imageKey]);

  // Auto-reconnect logic
  const attemptReconnect = useCallback(() => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setIsReconnecting(false);
      setStreamError(true);
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
      MAX_RECONNECT_DELAY
    );

    setIsReconnecting(true);
    setReconnectCountdown(Math.ceil(delay / 1000));

    countdownIntervalRef.current = setInterval(() => {
      setReconnectCountdown((prev) => {
        if (prev <= 1) {
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    reconnectTimerRef.current = setTimeout(() => {
      setReconnectAttempts((prev) => prev + 1);
      setIsReconnecting(false);
      setStreamLoading(true);
      setStreamError(false);
      if (imgRef.current) imgRef.current.src = '';
      setImageKey(Date.now());
    }, delay);
  }, [reconnectAttempts]);

  // Stall detection
  useEffect(() => {
    if (streamLoading || isReconnecting) {
      if (stallCheckIntervalRef.current) {
        clearInterval(stallCheckIntervalRef.current);
        stallCheckIntervalRef.current = null;
      }
      return;
    }

    stallCheckIntervalRef.current = setInterval(async () => {
      try {
        const status = await api.getCameraStatus(printerId);
        if (status.stalled || (!status.active && !streamError)) {
          if (stallCheckIntervalRef.current) {
            clearInterval(stallCheckIntervalRef.current);
            stallCheckIntervalRef.current = null;
          }
          setStreamLoading(false);
          attemptReconnect();
        }
      } catch {
        // Ignore errors
      }
    }, STALL_CHECK_INTERVAL);

    return () => {
      if (stallCheckIntervalRef.current) {
        clearInterval(stallCheckIntervalRef.current);
        stallCheckIntervalRef.current = null;
      }
    };
  }, [streamLoading, streamError, isReconnecting, printerId, attemptReconnect]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      const nowFullscreen = !!document.fullscreenElement && document.fullscreenElement === containerRef.current;
      setIsFullscreen(nowFullscreen);
      if (!nowFullscreen) {
        setZoomLevel(1);
        setPanOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current.requestFullscreen();
    }
  };

  const handleZoomIn = () => {
    setZoomLevel(prev => Math.min(prev + 0.5, 4));
  };

  const handleZoomOut = () => {
    setZoomLevel(prev => {
      const newZoom = Math.max(prev - 0.5, 1);
      if (newZoom === 1) setPanOffset({ x: 0, y: 0 });
      return newZoom;
    });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else {
      handleZoomOut();
    }
  };

  const handleImageMouseDown = (e: React.MouseEvent) => {
    if (zoomLevel > 1) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  };

  const getMaxPan = useCallback(() => {
    if (!containerRef.current) {
      return { x: 200, y: 150 };
    }
    const container = containerRef.current.getBoundingClientRect();
    const maxX = (container.width * (zoomLevel - 1)) / 2;
    const maxY = (container.height * (zoomLevel - 1)) / 2;
    return { x: Math.max(50, maxX), y: Math.max(50, maxY) };
  }, [zoomLevel]);

  const handleImageMouseMove = (e: React.MouseEvent) => {
    if (isPanning && zoomLevel > 1) {
      const newX = e.clientX - panStart.x;
      const newY = e.clientY - panStart.y;
      const maxPan = getMaxPan();
      setPanOffset({
        x: Math.max(-maxPan.x, Math.min(maxPan.x, newX)),
        y: Math.max(-maxPan.y, Math.min(maxPan.y, newY)),
      });
    }
  };

  const handleImageMouseUp = () => {
    setIsPanning(false);
  };

  const getTouchDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touches: React.TouchList) => {
    if (touches.length < 2) {
      return { x: touches[0].clientX, y: touches[0].clientY };
    }
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      setLastTouchDistance(getTouchDistance(e.touches));
      setLastTouchCenter(getTouchCenter(e.touches));
    } else if (e.touches.length === 1 && zoomLevel > 1) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({
        x: e.touches[0].clientX - panOffset.x,
        y: e.touches[0].clientY - panOffset.y,
      });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastTouchDistance !== null) {
      e.preventDefault();
      const newDistance = getTouchDistance(e.touches);
      const scale = newDistance / lastTouchDistance;

      setZoomLevel(prev => {
        const newZoom = Math.max(1, Math.min(4, prev * scale));
        if (newZoom === 1) {
          setPanOffset({ x: 0, y: 0 });
        }
        return newZoom;
      });

      setLastTouchDistance(newDistance);

      const newCenter = getTouchCenter(e.touches);
      if (lastTouchCenter) {
        const maxPan = getMaxPan();
        setPanOffset(prev => ({
          x: Math.max(-maxPan.x, Math.min(maxPan.x, prev.x + (newCenter.x - lastTouchCenter.x))),
          y: Math.max(-maxPan.y, Math.min(maxPan.y, prev.y + (newCenter.y - lastTouchCenter.y))),
        }));
      }
      setLastTouchCenter(newCenter);
    } else if (e.touches.length === 1 && isPanning && zoomLevel > 1) {
      e.preventDefault();
      const newX = e.touches[0].clientX - panStart.x;
      const newY = e.touches[0].clientY - panStart.y;
      const maxPan = getMaxPan();
      setPanOffset({
        x: Math.max(-maxPan.x, Math.min(maxPan.x, newX)),
        y: Math.max(-maxPan.y, Math.min(maxPan.y, newY)),
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      setLastTouchDistance(null);
      setLastTouchCenter(null);
    }
    if (e.touches.length === 0) {
      setIsPanning(false);
    }
  };

  const resetZoom = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const handleStreamError = () => {
    setStreamLoading(false);
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      attemptReconnect();
    } else {
      setStreamError(true);
    }
  };

  const handleStreamLoad = () => {
    setStreamLoading(false);
    setStreamError(false);
    setReconnectAttempts(0);
    setIsReconnecting(false);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
  };

  const refresh = () => {
    setStreamLoading(true);
    setStreamError(false);
    setReconnectAttempts(0);
    setIsReconnecting(false);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    const stopHeaders: Record<string, string> = {};
    const stopToken = getAuthToken();
    if (stopToken) stopHeaders['Authorization'] = `Bearer ${stopToken}`;
    fetch(`/api/v1/printers/${printerId}/camera/stop`, { method: 'POST', headers: stopHeaders }).catch(() => {});

    if (imgRef.current) imgRef.current.src = '';
    setTimeout(() => setImageKey(Date.now()), 100);
  };

  const streamUrl = withStreamToken(`/api/v1/printers/${printerId}/camera/stream?fps=15&t=${imageKey}`);

  return (
    <div
      ref={containerRef}
      className={`${isFullscreen ? 'fixed inset-0 z-[100]' : 'relative h-full'} bg-bambu-dark-secondary rounded-lg shadow-lg border border-bambu-dark-tertiary overflow-hidden flex flex-col`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-bambu-dark border-b border-bambu-dark-tertiary">
        <div className="flex items-center gap-2 text-sm text-white truncate">
          <span className="truncate">{printer?.name || printerName}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => chamberLightMutation.mutate(!status?.chamber_light)}
            disabled={!status?.connected || chamberLightMutation.isPending || !hasPermission('printers:control')}
            className={`p-1 rounded disabled:opacity-50 ${status?.chamber_light ? 'bg-yellow-500/20 hover:bg-yellow-500/30' : 'hover:bg-bambu-dark-tertiary'}`}
            title={!hasPermission('printers:control') ? t('printers.permission.noControl') : t('camera.chamberLight')}
          >
            <ChamberLight on={status?.chamber_light ?? false} className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setShowSkipObjectsModal(true)}
            disabled={!isPrintingWithObjects || !hasPermission('printers:control')}
            className={`p-1 rounded disabled:opacity-50 ${isPrintingWithObjects && hasPermission('printers:control') ? 'hover:bg-bambu-dark-tertiary' : ''}`}
            title={
              !hasPermission('printers:control')
                ? t('printers.permission.noControl')
                : !isPrintingWithObjects
                  ? t('printers.skipObjects.onlyWhilePrinting')
                  : t('printers.skipObjects.tooltip')
            }
          >
            <SkipObjectsIcon className="w-3.5 h-3.5 text-bambu-gray" />
          </button>
          <button
            onClick={refresh}
            disabled={streamLoading || isReconnecting}
            className="p-1 hover:bg-bambu-dark-tertiary rounded disabled:opacity-50"
            title={t('camera.restartStream')}
          >
            <RefreshCw className={`w-3.5 h-3.5 text-bambu-gray ${streamLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setShowDiagnoseModal(true)}
            className="p-1 hover:bg-bambu-dark-tertiary rounded"
            title={t('camera.diagnose.button')}
          >
            <Stethoscope className="w-3.5 h-3.5 text-bambu-gray" />
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-1 hover:bg-bambu-dark-tertiary rounded"
            title={isFullscreen ? t('camera.exitFullscreen') : t('camera.fullscreen')}
          >
            {isFullscreen ? (
              <Minimize className="w-3.5 h-3.5 text-bambu-gray" />
            ) : (
              <Fullscreen className="w-3.5 h-3.5 text-bambu-gray" />
            )}
          </button>
        </div>
      </div>

      {/* Video area */}
      <div
        className="relative flex-1 w-full bg-black flex items-center justify-center overflow-hidden"
        onWheel={handleWheel}
        onMouseMove={handleImageMouseMove}
        onMouseUp={handleImageMouseUp}
        onMouseLeave={handleImageMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ touchAction: 'none' }}
      >
        {streamLoading && !isReconnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <RefreshCw className="w-6 h-6 text-bambu-gray animate-spin" />
          </div>
        )}
        {isReconnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
            <div className="text-center p-2">
              <WifiOff className="w-6 h-6 text-orange-400 mx-auto mb-2" />
              <p className="text-xs text-bambu-gray">
                {t('camera.reconnecting', { countdown: reconnectCountdown, attempt: Math.min(reconnectAttempts + 1, MAX_RECONNECT_ATTEMPTS), max: MAX_RECONNECT_ATTEMPTS })}
              </p>
            </div>
          </div>
        )}
        {streamError && !isReconnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
            <div className="text-center p-2">
              <AlertTriangle className="w-6 h-6 text-orange-400 mx-auto mb-2" />
              <p className="text-xs text-bambu-gray mb-2">{t('camera.unavailable')}</p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={refresh}
                  className="px-2 py-1 text-xs bg-bambu-green text-white rounded hover:bg-bambu-green/80"
                >
                  {t('camera.retry')}
                </button>
                <button
                  onClick={() => setShowDiagnoseModal(true)}
                  className="px-2 py-1 text-xs bg-bambu-dark border border-bambu-dark-tertiary text-bambu-gray hover:text-white rounded transition-colors"
                >
                  {t('camera.diagnose.button')}
                </button>
              </div>
            </div>
          </div>
        )}
        <img
          ref={imgRef}
          key={imageKey}
          src={streamUrl}
          alt={t('camera.cameraStream')}
          className="max-w-full max-h-full object-contain select-none"
          style={{
            transform: `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px) rotate(${printer?.camera_rotation || 0}deg)`,
            ...(printer?.camera_rotation === 90 || printer?.camera_rotation === 270 ? { maxWidth: '100%', maxHeight: '100%' } : {}),
            cursor: zoomLevel > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default',
          }}
          onError={handleStreamError}
          onLoad={handleStreamLoad}
          onMouseDown={handleImageMouseDown}
          draggable={false}
        />

        {/* Zoom controls */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 rounded px-1.5 py-1">
          <button
            onClick={handleZoomOut}
            disabled={zoomLevel <= 1}
            className="p-1 hover:bg-white/10 rounded disabled:opacity-30"
            title={t('camera.zoomOut')}
          >
            <ZoomOut className="w-3.5 h-3.5 text-white" />
          </button>
          <button
            onClick={resetZoom}
            className="px-1.5 py-0.5 text-xs text-white hover:bg-white/10 rounded min-w-[32px]"
            title={t('camera.resetZoom')}
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            onClick={handleZoomIn}
            disabled={zoomLevel >= 4}
            className="p-1 hover:bg-white/10 rounded disabled:opacity-30"
            title={t('camera.zoomIn')}
          >
            <ZoomIn className="w-3.5 h-3.5 text-white" />
          </button>
        </div>
      </div>

      {/* Skip Objects Modal */}
      <SkipObjectsModal
        printerId={printerId}
        isOpen={showSkipObjectsModal}
        onClose={() => setShowSkipObjectsModal(false)}
      />
      {/* Camera diagnostic modal */}
      {showDiagnoseModal && (
        <CameraDiagnoseModal
          printerId={printerId}
          printerName={printer?.name || null}
          onClose={() => setShowDiagnoseModal(false)}
        />
      )}
    </div>
  );
}
