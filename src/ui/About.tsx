const buildDate = new Date(__BUILD_TIME__);

function formatDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return __BUILD_TIME__;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

export default function About() {
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="max-w-xl rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
        <h2 className="text-base font-semibold">About this build</h2>
        <div className="text-sm text-neutral-300 space-y-2">
          <p>
            <span className="text-neutral-500">Version:</span> {__APP_VERSION__}
          </p>
          <p>
            <span className="text-neutral-500">Build number:</span>{" "}
            {__BUILD_NUMBER__}
          </p>
          <p>
            <span className="text-neutral-500">Built at:</span>{" "}
            {formatDateTime(buildDate)}
          </p>
          <p className="text-xs text-neutral-500 break-all">
            {__BUILD_TIME__}
          </p>
        </div>
      </div>
    </div>
  );
}
