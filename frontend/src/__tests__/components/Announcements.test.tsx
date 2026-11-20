/**
 * Announcements from the Bambuddy maintainers: the sidebar entry above System,
 * the slide-over list, and the banner for unread important/critical messages.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { AnnouncementsPanel } from '../../components/AnnouncementsPanel';
import { AnnouncementBanner } from '../../components/AnnouncementBanner';
import { Layout } from '../../components/Layout';
import type { Announcement } from '../../api/client';

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    level: 'info',
    texts: { en: { title: 'Hello installs', body: 'Line one\nLine two' } },
    link_url: null,
    published_at: '2026-10-01T12:00:00Z',
    expires_at: null,
    archived: false,
    read: false,
    ...overrides,
  };
}

describe('AnnouncementsPanel', () => {
  it('lists titles collapsed, marks unread ones New, and marks read only on opening one', () => {
    const markRead = vi.fn();
    render(
      <AnnouncementsPanel
        open
        onClose={() => {}}
        markRead={markRead}
        announcements={[
          announcement({ texts: { en: { title: 'Fresh', body: 'Fresh body' } } }),
          announcement({ id: 'a2', read: true, texts: { en: { title: 'Old news', body: 'Old body' } } }),
        ]}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]).getByText('New')).toBeInTheDocument();
    expect(within(items[1]).queryByText('New')).not.toBeInTheDocument();
    // Collapsed: titles only, nothing read yet.
    expect(screen.queryByText('Fresh body')).not.toBeInTheDocument();
    expect(markRead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Fresh/ }));
    expect(screen.getByText('Fresh body')).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith('a1');

    // Opening one already read doesn't mark it again.
    fireEvent.click(screen.getByRole('button', { name: /Old news/ }));
    expect(screen.getByText('Old body')).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledTimes(1);

    // And it closes again.
    fireEvent.click(screen.getByRole('button', { name: /Fresh/ }));
    expect(screen.queryByText('Fresh body')).not.toBeInTheDocument();
  });

  it('opens with the message the banner pointed at expanded', () => {
    const markRead = vi.fn();
    render(
      <AnnouncementsPanel
        open
        focusId="b"
        onClose={() => {}}
        markRead={markRead}
        announcements={[
          announcement({ id: 'a', texts: { en: { title: 'A', body: 'A body' } } }),
          announcement({ id: 'b', texts: { en: { title: 'B', body: 'B body' } } }),
        ]}
      />
    );
    expect(screen.getByText('B body')).toBeInTheDocument();
    expect(screen.queryByText('A body')).not.toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith('b');
  });

  it('renders the body as plain text, never as HTML', () => {
    render(
      <AnnouncementsPanel
        open
        onClose={() => {}}
        markRead={() => {}}
        announcements={[announcement({ texts: { en: { title: 'T', body: '<img src=x onerror=alert(1)>' } } })]}
      />
    );
    fireEvent.click(screen.getByText('T'));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('links only to allowed hosts', () => {
    render(
      <AnnouncementsPanel
        open
        onClose={() => {}}
        markRead={() => {}}
        announcements={[
          announcement({ id: 'ok', link_url: 'https://wiki.bambuddy.cool/x/', texts: { en: { title: 'A', body: 'b', link_label: 'Details' } } }),
          announcement({ id: 'bad', link_url: 'https://evil.example/x', texts: { en: { title: 'B', body: 'b', link_label: 'Phish' } } }),
        ]}
      />
    );
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('B'));
    const link = screen.getByRole('link', { name: /Details/ });
    expect(link).toHaveAttribute('href', 'https://wiki.bambuddy.cool/x/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('link', { name: /Phish/ })).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<AnnouncementsPanel open onClose={onClose} markRead={() => {}} announcements={[announcement()]} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AnnouncementsPanel history', () => {
  it('lists expired messages under a collapsed Earlier section and never marks them', () => {
    const markRead = vi.fn();
    render(
      <AnnouncementsPanel
        open
        onClose={() => {}}
        markRead={markRead}
        announcements={[
          announcement({ id: 'old', archived: true, texts: { en: { title: 'Old news', body: 'x' } } }),
        ]}
      />
    );
    expect(screen.getByText('No announcements right now.')).toBeInTheDocument();
    expect(screen.queryByText('Old news')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier (1)' }));
    expect(screen.getByText('Old news')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Old news/ }));
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe('AnnouncementBanner', () => {
  it('shows the first item, offers the rest, and Got it marks it read', () => {
    const markRead = vi.fn();
    const onOpen = vi.fn();
    render(
      <AnnouncementBanner
        items={[
          announcement({ id: 'crit', level: 'critical', texts: { en: { title: 'Update now', body: 'b' } } }),
          announcement({ id: 'imp', level: 'important' }),
        ]}
        onOpen={onOpen}
        markRead={markRead}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Update now');
    fireEvent.click(screen.getByRole('button', { name: 'Read more (+1)' }));
    expect(onOpen).toHaveBeenCalledWith('crit');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(markRead).toHaveBeenCalledWith('crit');
  });

  it('renders nothing without items', () => {
    render(<AnnouncementBanner items={[]} onOpen={() => {}} markRead={() => {}} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Layout with announcements', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
      http.get('/api/v1/settings/ui-flags', () =>
        HttpResponse.json({ check_updates: false, billing_enabled: false, user_notifications_enabled: true, currency: 'EUR' })
      )
    );
  });

  it('keeps the entry with nothing published, opening an empty list', async () => {
    // The entry is where announcements live, not a notice that one arrived: it
    // stays for whoever may see them, with no count and no banner.
    render(<Layout />);
    const entry = await screen.findByRole('button', { name: /announcements/i });
    expect(within(entry).queryByText(/\d/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(entry);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No announcements right now.')).toBeInTheDocument();
  });

  it('shows no entry for someone who may not see announcements', async () => {
    server.use(
      http.get('/api/v1/announcements', () => HttpResponse.json({ visible: false, announcements: [] }))
    );
    render(<Layout />);
    await waitFor(() => expect(screen.getAllByTitle(/System/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /announcements/i })).not.toBeInTheDocument();
  });

  it('keeps the entry for history alone, with no count and no banner', async () => {
    server.use(
      http.get('/api/v1/announcements', () =>
        HttpResponse.json({
          visible: true,
          announcements: [announcement({ id: 'old', level: 'critical', archived: true })],
        })
      )
    );
    render(<Layout />);
    const entry = await screen.findByRole('button', { name: /announcements/i });
    expect(within(entry).queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the entry with an unread count, the banner for important, and opens the list', async () => {
    let reads: string[] = [];
    server.use(
      http.get('/api/v1/announcements', () =>
        HttpResponse.json({
          visible: true,
          announcements: [
            announcement({ id: 'imp', level: 'important', texts: { en: { title: 'Breaking change in 2.0', body: 'b' } } }),
            announcement({ id: 'inf', level: 'info', texts: { en: { title: 'Testers wanted', body: 'b' } } }),
          ],
        })
      ),
      http.post('/api/v1/announcements/:id/read', ({ params }) => {
        reads = [...reads, String(params.id)];
        return new HttpResponse(null, { status: 204 });
      })
    );
    render(<Layout />);

    const entry = await screen.findByRole('button', { name: /announcements/i });
    expect(within(entry).getByText('2')).toBeInTheDocument();
    // Only the important one earns a banner.
    expect(screen.getByRole('status')).toHaveTextContent('Breaking change in 2.0');
    expect(screen.queryByText('Testers wanted')).not.toBeInTheDocument();

    fireEvent.click(entry);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Testers wanted')).toBeInTheDocument();
    // Opening the panel reads nothing; opening a message reads that one.
    expect(reads).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: /Breaking change in 2.0/ }));
    await waitFor(() => expect(reads).toEqual(['imp']));
    // Read now: its banner is gone, the info one is still unread.
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(within(dialog).getAllByText('New')).toHaveLength(1);
  });
});
