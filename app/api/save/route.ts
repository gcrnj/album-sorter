import { savePlan } from "@/lib/local-files";


export async function POST(request: Request) {
  try {
    const body = await request.json();
    return Response.json(await savePlan(body.folderId, body.changes));
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
