export function createChunkEmitter(onChunk, minimumSize = 80) {
  let buffer = '';

  const flush = () => {
    if (!buffer || typeof onChunk !== 'function') return;
    const chunk = buffer;
    buffer = '';
    onChunk(chunk);
  };

  return {
    push(text) {
      if (!text) return;
      buffer += text;
      if (buffer.length >= minimumSize || buffer.includes('\n')) flush();
    },
    flush
  };
}

export async function readSSE(response, onEvent) {
  let buffer = '';

  for await (const rawChunk of response.body) {
    buffer += rawChunk.toString('utf8');
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';

    for (const eventBlock of events) {
      const data = eventBlock
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');

      if (data) await onEvent(data);
    }
  }

  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (data) await onEvent(data);
  }
}
