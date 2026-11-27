import { useState } from "react";
import type { RecoveryHandlerRequest } from "../main/seo-ops-sync";
import type { Command, State } from "../shared/contracts";

export function RecoveryHandlerRequests({ invoke, onState, locked }: {
  invoke: <T>(command: Command) => Promise<T>;
  onState?: (state: State) => void;
  locked: boolean;
}) {
  const [requests, setRequests] = useState<RecoveryHandlerRequest[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setRequests(await invoke<RecoveryHandlerRequest[]>({ type: "listRecoveryHandlerRequests" }));
  }

  async function run(action: () => Promise<void>) {
    if (busy || locked) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recovery Handler request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details>
      <summary>Recovery Handler requests</summary>
      <button disabled={busy || locked} onClick={() => void run(refresh)}>Refresh requests</button>
      {error && <p role="alert">{error}</p>}
      {requests?.length === 0 && <p>No Recovery Handler requests.</p>}
      {requests?.map((request) => (
        <section key={request.request_uuid}>
          <h4>{request.error_tag?.name ?? "Unavailable Error Tag"} · {request.status}</h4>
          {request.error_tag && <p>{request.error_tag.platform} {request.error_tag.site_scope} · {request.error_tag.id}</p>}
          {request.notes && <p>{request.notes}</p>}
          {request.created_at && <time dateTime={request.created_at}>{new Date(request.created_at).toLocaleString()}</time>}
          {request.status === "pending" && <button disabled={busy || locked} onClick={() => void run(async () => {
            await invoke({ type: "claimRecoveryHandlerRequest", requestUuid: request.request_uuid });
            await refresh();
          })}>Claim</button>}
          {request.status === "developing" && request.error_tag && <button disabled={busy || locked} onClick={() => void run(async () => {
            onState?.(await invoke<State>({ type: "openRecoveryHandlerDraft", requestUuid: request.request_uuid }));
          })}>Open Script Builder draft</button>}
        </section>
      ))}
    </details>
  );
}
