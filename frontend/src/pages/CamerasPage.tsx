import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Video, VideoOff, LayoutGrid, History } from 'lucide-react';
import { api } from '../api/client';
import { CameraGridTile } from '../components/CameraGridTile';
import { CameraTimelineView } from '../components/camera-timeline/CameraTimelineView';

type ViewMode = 'grid' | 'detail';

export function CamerasPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  const activePrinters = printers?.filter(p => p.is_active) ?? [];

  return (
    <div className={`p-4 md:p-8 flex flex-col ${viewMode === 'detail' ? 'h-full overflow-hidden' : 'min-h-full'}`}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Video className="w-7 h-7 text-bambu-green" />
            {t('camera.grid.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('camera.grid.subtitle')}</p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setViewMode('grid')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              viewMode === 'grid'
                ? 'bg-bambu-green text-white'
                : 'bg-bambu-dark-secondary border border-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            {t('camera.timeline.viewGrid')}
          </button>
          <button
            onClick={() => setViewMode('detail')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              viewMode === 'detail'
                ? 'bg-bambu-green text-white'
                : 'bg-bambu-dark-secondary border border-bambu-dark-tertiary text-bambu-gray hover:text-white'
            }`}
          >
            <History className="w-4 h-4" />
            {t('camera.timeline.viewDetail')}
          </button>
        </div>
      </div>

      {activePrinters.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16">
          <VideoOff className="w-12 h-12 text-bambu-dark-tertiary mb-3" />
          <p className="text-bambu-gray">{t('camera.grid.empty')}</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div
          className="grid gap-4 flex-1"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gridAutoRows: 'minmax(280px, 1fr)' }}
        >
          {activePrinters.map(printer => (
            <CameraGridTile key={printer.id} printerId={printer.id} printerName={printer.name} />
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <CameraTimelineView printers={activePrinters} />
        </div>
      )}
    </div>
  );
}
