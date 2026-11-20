import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { announcementsApi, type Announcement, type AnnouncementList, type AnnouncementText } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

// Hosts a message may link to. The backend already drops any other link; this
// is the second check, so a bad link never becomes a clickable one.
const LINK_HOSTS = ['github.com', 'bambuddy.cool'];

export function isAllowedAnnouncementLink(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase();
    return LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/** The message in the UI language when it was written in it, else English. */
export function announcementText(announcement: Announcement, language: string): AnnouncementText {
  const { texts } = announcement;
  if (texts[language]) return texts[language];
  const lower = language.toLowerCase();
  const sameCase = Object.keys(texts).find((key) => key.toLowerCase() === lower);
  if (sameCase) return texts[sameCase];
  // "pt" finds "pt-BR", "zh-HK" finds "zh-TW" or "zh-CN" -- closer than English.
  const base = lower.split('-')[0];
  const sameBase = Object.keys(texts).find((key) => key.toLowerCase().split('-')[0] === base);
  return sameBase ? texts[sameBase] : texts.en;
}

const SEVERITY: Record<Announcement['level'], number> = { critical: 2, important: 1, info: 0 };

/**
 * Announcements from the Bambuddy maintainers, for whoever may see them.
 *
 * The backend says whether this user may see them at all (`visible`: switched
 * on, and admin or "show to all users"), so there is no separate permission
 * check here. `visible` with an empty list is an empty inbox, not "hide".
 */
export function useAnnouncements() {
  const { authEnabled, user, loading } = useAuth();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['announcements'],
    queryFn: announcementsApi.list,
    enabled: !loading && (!authEnabled || !!user),
    staleTime: 5 * 60 * 1000,
    // A local read of what the backend fetched; the backend itself only goes
    // to GitHub every few hours.
    refetchInterval: 10 * 60 * 1000,
  });
  const visible = data?.visible ?? false;
  const announcements = useMemo(() => data?.announcements ?? [], [data]);

  const markReadMutation = useMutation({
    mutationFn: announcementsApi.markRead,
    onMutate: (id: string) => {
      queryClient.setQueryData<AnnouncementList>(['announcements'], (old) =>
        old && { ...old, announcements: old.announcements.map((a) => (a.id === id ? { ...a, read: true } : a)) }
      );
    },
    onError: () => queryClient.invalidateQueries({ queryKey: ['announcements'] }),
  });
  const { mutate } = markReadMutation;
  const markRead = useCallback((id: string) => mutate(id), [mutate]);

  // History is never unread: it was current once, and either read then or missed.
  const unread = useMemo(() => announcements.filter((a) => !a.read && !a.archived), [announcements]);

  // What earns a banner: important or critical, not yet read. Most severe first,
  // then newest (the list already comes newest first).
  const bannerItems = useMemo(
    () =>
      unread
        .filter((a) => a.level !== 'info')
        .sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level]),
    [unread]
  );

  return { visible, announcements, unread, bannerItems, markRead };
}
