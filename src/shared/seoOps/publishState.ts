export type ScriptPublishMeta = {
  script_key?: string;
  version?: string;
  last_publish?: {
    script_key: string;
    version: string;
    content_digest: string;
    outcome: string;
    published_at: string;
  };
};

export function mergeScriptPublishMeta(
  existing: ScriptPublishMeta | null | undefined,
  patch: ScriptPublishMeta,
): ScriptPublishMeta {
  const current = existing && typeof existing === "object" ? { ...existing } : {};
  const next: ScriptPublishMeta = { ...current, ...patch };
  if (patch.last_publish) {
    next.last_publish = {
      ...(current.last_publish || {
        script_key: "",
        version: "",
        content_digest: "",
        outcome: "",
        published_at: "",
      }),
      ...patch.last_publish,
    };
  }
  return next;
}

export function markScriptPublished(
  existing: ScriptPublishMeta | null | undefined,
  data: {
    script_key: string;
    version: string;
    content_digest: string;
    outcome: string;
    published_at?: string;
  },
): ScriptPublishMeta {
  return mergeScriptPublishMeta(existing, {
    script_key: data.script_key,
    version: data.version,
    last_publish: {
      script_key: data.script_key,
      version: data.version,
      content_digest: data.content_digest,
      outcome: data.outcome,
      published_at: data.published_at || new Date().toISOString(),
    },
  });
}

export function shouldSkipScriptPublish(exportOk: boolean, unchanged: boolean): boolean {
  return exportOk && unchanged;
}
