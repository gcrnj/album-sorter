import { undoLastSave } from "@/lib/local-files";


export async function POST() {
  try { return Response.json(await undoLastSave()); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
