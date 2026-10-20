// Parses large JSON payloads off the main thread so the dashboard stays responsive.
self.onmessage = (event: MessageEvent<string>) => {
  try {
    (self as unknown as Worker).postMessage({ ok: true, value: JSON.parse(event.data) });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
