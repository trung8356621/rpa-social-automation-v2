import React, { useEffect, useState } from "react";
import type { UploadFileValidation, Variable, VariableValues } from "../shared/contracts";

export async function validateFileValues(variables: Variable[], values: VariableValues) {
  return Promise.all(variables.filter(variable => variable.type === "file" || variable.type === "files").map(async variable => ({
    variable,
    report: await window.creator.invoke({ type: "validateUploadFiles", files: variable.type === "file" && typeof values[variable.id] === "string" ? [values[variable.id]] : values[variable.id] }) as UploadFileValidation,
  })));
}

export function FileValidation({ value, disabled, onChange, refreshKey = 0 }: {
  value: string | string[] | number | undefined;
  disabled: boolean;
  onChange: (value: string[]) => void;
  refreshKey?: number;
}) {
  const files = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const [report, setReport] = useState<UploadFileValidation>();
  async function validate(next = files) {
    setReport(await window.creator.invoke({ type: "validateUploadFiles", files: next }) as UploadFileValidation);
  }
  useEffect(() => { void validate(); }, [refreshKey]);
  return <div className="file-validation">
    <div><button type="button" disabled={disabled} onClick={() => void window.creator.invoke({ type: "pickUploadFiles" }).then(value => {
      if (!value) return;
      const selected = value as string[]; onChange(selected); void validate(selected);
    })}>Chọn lại file</button>
      {report && <small data-status={report.status}> {report.validCount} hợp lệ / {report.invalidCount} không hợp lệ</small>}</div>
    {report?.files.map((file, index) => <div className="file-validation-row" data-status={file.status} key={`${file.path}-${index}`}>
      <span>{file.status === "VALID" ? "✓" : "⚠"} {file.name}</span>{file.reason && <small>{file.reason}</small>}
    </div>)}
  </div>;
}
