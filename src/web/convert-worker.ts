import { convertSwfToLottie } from "../core/convert.js";
import { ConversionError } from "../core/issues.js";

interface ConvertRequestMessage {
  type: "convert";
  requestId: number;
  filename: string;
  buffer: ArrayBuffer;
}

type ConvertResponseMessage =
  | {
      type: "result";
      requestId: number;
      ok: true;
      animation: Record<string, unknown> | null;
      bitmapAssets: unknown[];
      issues: unknown[];
    }
  | {
      type: "result";
      requestId: number;
      ok: false;
      message: string;
      issues: unknown[];
    };

self.addEventListener("message", (event: MessageEvent<ConvertRequestMessage>) => {
  const message = event.data;
  if (!message || message.type !== "convert") {
    return;
  }

  try {
    const result = convertSwfToLottie(message.buffer);
    const response: ConvertResponseMessage = {
      type: "result",
      requestId: message.requestId,
      ok: true,
      animation: result.animation,
      bitmapAssets: result.bitmapAssets,
      issues: result.issues
    };
    self.postMessage(response);
  } catch (error) {
    const response: ConvertResponseMessage = {
      type: "result",
      requestId: message.requestId,
      ok: false,
      message: error instanceof Error ? error.message : "Conversion failed.",
      issues: error instanceof ConversionError ? error.issues : []
    };
    self.postMessage(response);
  }
});

export {};
