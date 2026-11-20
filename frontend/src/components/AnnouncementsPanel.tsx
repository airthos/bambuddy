import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, Megaphone, X } from 'lucide-react';
import type { Announcement, AnnouncementLevel } from '../api/client';
import { announcementText, isAllowedAnnouncementLink } from '../hooks/useAnnouncements';
import { formatDateOnly } from '../utils/date';

const LEVEL_CHIP: Record<AnnouncementLevel, string> = {
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  important: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300',
};

interface AnnouncementsPanelProps {
  open: boolean;
  onClose: () => void;
  announcements: Announcement[];
  markRead: (id: string) => void;
  // Expanded when the panel opens: the banner's "Read more" lands on its message.
  focusId?: string | null;
}

/**
 * Slide-over list of announcements from the Bambuddy maintainers.
 *
 * Each message is one row -- level, date, title -- and opens in place. Unread
 * ones carry a dot and a "New" chip until opened; opening is what marks a
 * message read, so the sidebar count is what is still unopened. Expired messages
 * the feed keeps as history sit in a collapsed "Earlier" section below; they are
 * never unread.
 */
export function AnnouncementsPanel({ open, onClose, announcements, markRead, focusId }: AnnouncementsPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showEarlier, setShowEarlier] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ announcements, markRead });
  latest.current = { announcements, markRead };

  const expand = useCallback((id: string) => {
    setExpanded((prev) => new Set(prev).add(id));
    const a = latest.current.announcements.find((x) => x.id === id);
    if (a && !a.read && !a.archived) latest.current.markRead(id);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      if (expanded.has(id)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        expand(id);
      }
    },
    [expanded, expand]
  );

  useEffect(() => {
    if (!open) return;
    // Every visit starts collapsed, apart from the message the banner pointed at.
    setExpanded(new Set());
    setShowEarlier(false);
    if (focusId) expand(focusId);
    closeRef.current?.focus();
  }, [open, focusId, expand]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const current = announcements.filter((a) => !a.archived);
  const earlier = announcements.filter((a) => a.archived);

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-[60]" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcements-title"
        className="fixed inset-y-0 right-0 z-[61] w-full max-w-md bg-bambu-dark-secondary border-l border-bambu-dark-tertiary flex flex-col shadow-2xl"
      >
        <header className="flex items-center gap-3 px-5 py-4 border-b border-bambu-dark-tertiary">
          <Megaphone className="w-5 h-5 text-bambu-green" />
          <h2 id="announcements-title" className="text-lg font-semibold text-white">
            {t('announcements.title')}
          </h2>
          <button
            ref={closeRef}
            onClick={onClose}
            className="ml-auto p-2 -mr-2 rounded-lg text-bambu-gray-light hover:text-white hover:bg-bambu-dark-tertiary transition-colors"
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {current.length === 0 ? (
            <p className="p-6 text-center text-bambu-gray">{t('announcements.empty')}</p>
          ) : (
            <ul className="divide-y divide-bambu-dark-tertiary">
              {current.map((a) => (
                <AnnouncementItem key={a.id} announcement={a} expanded={expanded.has(a.id)} onToggle={toggle} />
              ))}
            </ul>
          )}
          {earlier.length > 0 && (
            <section className="border-t border-bambu-dark-tertiary">
              <button
                onClick={() => setShowEarlier((v) => !v)}
                aria-expanded={showEarlier}
                className="w-full flex items-center gap-2 px-5 py-3 text-sm font-medium text-bambu-gray-light hover:text-white hover:bg-bambu-dark-tertiary transition-colors"
              >
                {showEarlier ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                {t('announcements.earlier', { count: earlier.length })}
              </button>
              {showEarlier && (
                <ul className="divide-y divide-bambu-dark-tertiary opacity-80">
                  {earlier.map((a) => (
                    <AnnouncementItem key={a.id} announcement={a} expanded={expanded.has(a.id)} onToggle={toggle} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-bambu-dark-tertiary text-xs text-bambu-gray">
          {t('announcements.source')}
        </footer>
      </aside>
    </>
  );
}

interface AnnouncementItemProps {
  announcement: Announcement;
  expanded: boolean;
  onToggle: (id: string) => void;
}

function AnnouncementItem({ announcement: a, expanded, onToggle }: AnnouncementItemProps) {
  const { t, i18n } = useTranslation();
  const text = announcementText(a, i18n.language);
  const link = isAllowedAnnouncementLink(a.link_url) ? a.link_url : null;
  const unread = !a.read && !a.archived;
  const bodyId = `announcement-body-${a.id}`;
  return (
    <li>
      <button
        onClick={() => onToggle(a.id)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="w-full text-left px-5 py-3 flex items-start gap-3 hover:bg-bambu-dark-tertiary transition-colors"
      >
        <span className="mt-1.5 w-2 h-2 flex-shrink-0 rounded-full" aria-hidden="true">
          {unread && <span className="block w-2 h-2 rounded-full bg-bambu-green" />}
        </span>
        <span className="flex-1 min-w-0 space-y-1">
          <span className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`px-2 py-0.5 rounded-full font-semibold ${LEVEL_CHIP[a.level]}`}>
              {t(`announcements.level.${a.level}`)}
            </span>
            {unread && (
              <span className="px-2 py-0.5 rounded-full font-semibold bg-bambu-green/20 text-bambu-green">
                {t('announcements.new')}
              </span>
            )}
            {a.published_at && <span className="ml-auto text-bambu-gray">{formatDateOnly(a.published_at)}</span>}
          </span>
          <span className={`block text-balance ${unread ? 'text-white font-semibold' : 'text-bambu-gray-light font-medium'}`}>
            {text.title}
          </span>
        </span>
        <ChevronDown
          className={`w-4 h-4 mt-1 flex-shrink-0 text-bambu-gray transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div id={bodyId} className="pl-10 pr-5 pb-4 space-y-2">
          <p className="text-sm text-bambu-gray-light whitespace-pre-line break-words">{text.body}</p>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-bambu-green hover:underline"
            >
              {text.link_label || t('announcements.readMore')}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
