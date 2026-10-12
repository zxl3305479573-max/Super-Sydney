import { desktopCapturer } from 'electron';

export async function capturePrimaryScreen(): Promise<Buffer | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
    fetchWindowIcons: false
  });
  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail.toPNG();
}
