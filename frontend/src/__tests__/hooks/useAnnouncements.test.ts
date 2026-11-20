import { describe, it, expect } from 'vitest';
import { announcementText, isAllowedAnnouncementLink } from '../../hooks/useAnnouncements';
import type { Announcement } from '../../api/client';

const a = (texts: Announcement['texts']): Announcement => ({
  id: 'x', level: 'info', texts, link_url: null, published_at: null, expires_at: null, archived: false, read: false,
});

describe('announcementText', () => {
  const texts = {
    en: { title: 'Hello', body: 'b' },
    de: { title: 'Hallo', body: 'b' },
    'pt-BR': { title: 'Olá', body: 'b' },
    'zh-CN': { title: '你好', body: 'b' },
  };

  it.each([
    ['de', 'Hallo'],
    ['pt-BR', 'Olá'],
    ['pt-br', 'Olá'],
    ['pt', 'Olá'],
    ['zh-TW', '你好'],
    ['fr', 'Hello'],
    ['en-US', 'Hello'],
  ])('%s -> %s', (lang, title) => {
    expect(announcementText(a(texts), lang).title).toBe(title);
  });
});

describe('isAllowedAnnouncementLink', () => {
  it.each([
    ['https://wiki.bambuddy.cool/x', true],
    ['https://bambuddy.cool', true],
    ['https://github.com/maziggy/bambuddy', true],
    ['http://github.com/', false],
    ['https://github.com.evil.example/', false],
    ['https://user:pw@github.com/', false],
    ['https://github.com:8443/', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    [null, false],
  ])('%s -> %s', (url, allowed) => {
    expect(isAllowedAnnouncementLink(url)).toBe(allowed);
  });
});
