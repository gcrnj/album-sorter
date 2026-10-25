import { getFolderStatus } from "@/lib/local-files";

export async function GET(request: Request) {
  try {
    const folderId = new URL(request.url).searchParams.get("id") || "";
    return Response.json(getFolderStatus(folderId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 404 }); }
}
