import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { loadView } from "../ui/load-view.js";

export const WORLD_CLOCK_URI = "ui://alexa-base/world-clock.html";

export interface ClockReading {
  timezone: string;
  iso: string;
  localTime: string;
  localDate: string;
  utcOffset: string;
  spoken: string;
}

/** Throws RangeError for an unknown IANA time zone. */
export function readClock(timezone: string, now: Date = new Date()): ClockReading {
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...opts }).format(now);
  const localTime = fmt({ hour: "numeric", minute: "2-digit", hour12: true });
  const localDate = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const utcOffset = fmt({ timeZoneName: "longOffset" }).split(" ").pop()!;
  const place = timezone.split("/").pop()!.replace(/_/g, " ");
  return {
    timezone,
    iso: now.toISOString(),
    localTime,
    localDate,
    utcOffset,
    spoken: `It is ${localTime} in ${place}, on ${localDate}.`,
  };
}

export function register(server: McpServer): void {
  registerAppTool(
    server,
    "world_clock",
    {
      title: "World clock",
      description:
        "Get the current local time and date in an IANA time zone, for example Asia/Tokyo or America/New_York. Shows a clock card on screens and speaks the time on voice-only devices.",
      inputSchema: {
        timezone: z.string().min(1).default("UTC").describe("IANA time zone name, for example Europe/Paris"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: WORLD_CLOCK_URI } },
    },
    async ({ timezone }) => {
      try {
        const reading = readClock(timezone);
        return { content: [{ type: "text", text: reading.spoken }], structuredContent: { ...reading } };
      } catch {
        return {
          isError: true,
          content: [{ type: "text", text: `I do not know the time zone "${timezone}". Try a name like Asia/Tokyo or America/New_York.` }],
          structuredContent: { error: "invalid_timezone", timezone },
        };
      }
    },
  );

  registerAppResource(
    server,
    "World clock card",
    WORLD_CLOCK_URI,
    { description: "768x480 clock card for the world_clock tool", mimeType: RESOURCE_MIME_TYPE },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: loadView("world-clock"), _meta: { ui: { prefersBorder: false } } }],
    }),
  );
}
