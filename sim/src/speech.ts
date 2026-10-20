interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const recognitionSupported = (): boolean => recognitionCtor() !== null;
export const synthesisSupported = (): boolean => "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow the microphone for this page, or type instead.",
  "service-not-allowed": "This browser does not allow speech recognition here. Type instead.",
  "no-speech": "No speech was heard. Tap the mic and try again, or type instead.",
  "audio-capture": "No microphone was found. Type instead.",
  network: "Speech recognition needs a network connection to the browser's speech service. Type instead.",
  aborted: "Listening was stopped.",
  "language-not-supported": "Speech recognition does not support this language here.",
};

export interface Listener {
  stop(): void;
}

/** Starts one recognition session. Every failure is reported through onError; nothing is swallowed. */
export function listen(handlers: {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}): Listener | null {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    handlers.onError("This browser has no speech recognition (Web Speech API). Type instead, or use Brave or Chrome.");
    return null;
  }
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) handlers.onInterim(finalText + interim);
  };
  rec.onerror = (e) => handlers.onError(ERRORS[e.error] ?? `Speech recognition error: ${e.error}${e.message ? ` (${e.message})` : ""}`);
  rec.onend = () => {
    if (finalText.trim()) handlers.onFinal(finalText.trim());
    handlers.onEnd();
  };
  try {
    rec.start();
  } catch (e) {
    handlers.onError(`Could not start listening: ${e instanceof Error ? e.message : String(e)}`);
    handlers.onEnd();
    return null;
  }
  return { stop: () => rec.stop() };
}

export function speak(text: string, handlers: { onStart(): void; onEnd(): void; onError(message: string): void }): void {
  if (!synthesisSupported()) {
    handlers.onError("This browser cannot speak (no speechSynthesis). The caption is the answer.");
    handlers.onEnd();
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  u.voice = voices.find((v) => v.lang === "en-US" && /samantha|aria|jenny|google us english|female/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
  u.rate = 1.02;
  u.onstart = handlers.onStart;
  u.onend = handlers.onEnd;
  u.onerror = (e) => {
    if (e.error !== "canceled" && e.error !== "interrupted") handlers.onError(`Speech output failed: ${e.error}`);
    handlers.onEnd();
  };
  synth.speak(u);
}

export function stopSpeaking(): void {
  if (synthesisSupported()) window.speechSynthesis.cancel();
}
