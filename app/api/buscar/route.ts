import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json(
    {
      error:
        "A busca imediata foi desativada. Entre no FastBus e crie um monitoramento.",
    },
    { status: 410 },
  );
}
