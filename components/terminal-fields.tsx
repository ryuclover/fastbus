import type { MonitorConfig } from "../lib/monitoring/schema";

export function TerminalFields({
  form,
  onChange,
}: {
  form: MonitorConfig;
  onChange: (next: MonitorConfig) => void;
}) {
  return (
    <details
      className="fb-full"
      open={form.originTerminal || form.destinationTerminal ? true : undefined}
    >
      <summary>Filtrar por terminal</summary>
      {(["originTerminal", "destinationTerminal"] as const).map(
        (key, index) => (
          <label key={key}>
            {index ? "Terminal de desembarque" : "Terminal de embarque"}
            <input
              value={form[key] ?? ""}
              maxLength={160}
              placeholder="Qualquer terminal"
              onChange={(e) =>
                onChange({ ...form, [key]: e.target.value || undefined })
              }
            />
          </label>
        ),
      )}
      <small>
        Use o nome do terminal exibido pela fonte. Só entram ofertas que
        confirmam esse terminal.
      </small>
    </details>
  );
}
