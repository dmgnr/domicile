// The stand-in for Electron's `crashReporter`. The engine's processes aren't
// the app's to report on, so nothing is collected or uploaded; the
// parameters an app sets are kept, as Electron's are, for it to read back.

export const createCrashReporter = () => {
  const parameters = new Map<string, string>();
  let upload = false;
  return {
    addExtraParameter: (key: string, value: string) => {
      parameters.set(key, value);
    },
    getLastCrashReport: () => null,
    getParameters: () => Object.fromEntries(parameters),
    getUploadedReports: () => [],
    getUploadToServer: () => upload,
    removeExtraParameter: (key: string) => {
      parameters.delete(key);
    },
    setUploadToServer: (value: boolean) => {
      upload = value;
    },
    start: (
      options: {
        uploadToServer?: boolean;
        extra?: Record<string, string>;
        globalExtra?: Record<string, string>;
      } = {},
    ) => {
      upload = options.uploadToServer ?? true;
      for (const [key, value] of Object.entries({
        ...options.globalExtra,
        ...options.extra,
      })) {
        parameters.set(key, value);
      }
    },
  };
};
