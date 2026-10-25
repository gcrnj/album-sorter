import { openFolder } from "@/lib/local-files";


export async function GET() {
  try { return Response.json(await openFolder()); }
  catch (error) {
    const message = (error as Error).message;
    return Response.json({ error: message }, { status: message === "Folder selection cancelled" ? 409 : 500 });
  }
}
