import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Video, VideoOff } from 'lucide-react';
import { api } from '../api/client';
import { CameraGridTile } from '../components/CameraGridTile';

export function CamerasPage() {
  const { t } = useTranslation();

  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  const activePrinters = printers?.filter(p => p.is_active) ?? [];

  return (
    <div className="p-4 md:p-8 flex flex-col min-h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
          <Video className="w-7 h-7 text-bambu-green" />
          {t('camera.grid.title')}
        </h1>
        <p className="text-bambu-gray mt-1">{t('camera.grid.subtitle')}</p>
      </div>

      {activePrinters.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16">
          <VideoOff className="w-12 h-12 text-bambu-dark-tertiary mb-3" />
          <p className="text-bambu-gray">{t('camera.grid.empty')}</p>
        </div>
      ) : (
        <div
          className="grid gap-4 flex-1"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gridAutoRows: 'minmax(280px, 1fr)' }}
        >
          {activePrinters.map(printer => (
            <CameraGridTile key={printer.id} printerId={printer.id} printerName={printer.name} />
          ))}
        </div>
      )}
    </div>
  );
}
