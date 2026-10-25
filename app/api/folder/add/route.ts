import { addPhotos } from "@/lib/local-files";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return Response.json(await addPhotos(body.folderId));
  } catch (error) {
    const message = (error as Error).message;
    return Response.json({ error: message }, { status: message === "Photo selection cancelled" ? 409 : 400 });
  }
}
