import { useTranslation } from 'react-i18next';
import { AlertTriangle, Megaphone } from 'lucide-react';
import type { Announcement } from '../api/client';
import { announcementText } from '../hooks/useAnnouncements';

interface AnnouncementBannerProps {
  // Unread important/critical announcements, most severe first.
  items: Announcement[];
  // Opens the panel with this message expanded.
  onOpen: (id: string) => void;
  markRead: (id: string) => void;
}

/**
 * The strip above the page for an unread important or critical announcement.
 *
 * One at a time, the most severe; "+N more" opens the panel. "Got it" marks it
 * read on the server, so it stays gone on every browser this user signs in on.
 * Info-level messages never get a banner -- only the sidebar dot.
 */
export function AnnouncementBanner({ items, onOpen, markRead }: AnnouncementBannerProps) {
  const { t, i18n } = useTranslation();
  const first = items[0];
  if (!first) return null;
  const text = announcementText(first, i18n.language);
  const critical = first.level === 'critical';
  const Icon = critical ? AlertTriangle : Megaphone;

  return (
    <div
      role={critical ? 'alert' : 'status'}
      className={`px-4 py-2 flex items-center gap-3 border-b text-sm ${
        critical
          ? 'bg-red-100 dark:bg-red-500/20 border-red-300 dark:border-red-500/30'
          : 'bg-amber-100 dark:bg-amber-500/20 border-amber-300 dark:border-amber-500/30'
      }`}
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${critical ? 'text-red-500' : 'text-amber-500'}`} />
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap min-w-0">
        <span className={`font-medium ${critical ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'}`}>
          {text.title}
        </span>
        <button
          onClick={() => onOpen(first.id)}
          className={`font-medium underline ${
            critical
              ? 'text-red-700 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300'
              : 'text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-300'
          }`}
        >
          {items.length > 1
            ? t('announcements.readMoreCount', { count: items.length - 1 })
            : t('announcements.readMore')}
        </button>
      </div>
      <button
        onClick={() => markRead(first.id)}
        className="ml-auto flex-shrink-0 px-2 py-1 rounded font-medium text-bambu-gray-light hover:text-white hover:bg-bambu-dark-tertiary transition-colors"
      >
        {t('announcements.gotIt')}
      </button>
    </div>
  );
}
