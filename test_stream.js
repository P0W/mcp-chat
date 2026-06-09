const stream = new ReadableStream({
  start(controller) {
    // never enqueue anything
  }
});
const reader = stream.getReader();
reader.read().then(r => console.log("READ:", r)).catch(e => console.error("ERR:", e));
reader.cancel("aborted").then(() => console.log("CANCELLED"));
