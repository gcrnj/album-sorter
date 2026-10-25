import { getThumbnail } from "@/lib/local-files";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";


export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    const result = await getThumbnail(id);
    const stream = Readable.toWeb(createReadStream(result.filePath)) as ReadableStream;
    return new Response(stream, { headers: { "Content-Type": result.type, "Cache-Control": "private, no-cache" } });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 404 }); }
}
