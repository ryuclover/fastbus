import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json(
    {
      error:
        "Consultas diretas foram desativadas. Use os monitoramentos autenticados.",
    },
    { status: 410 },
  );
}
