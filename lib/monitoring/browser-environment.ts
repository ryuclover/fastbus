/** The public search browser needs OS/display settings, not application credentials. */
export function publicBrowserEnvironment(
  source: Record<string, string | undefined> = process.env,
) {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "TZ",
    "LD_LIBRARY_PATH",
    "FONTCONFIG_PATH",
    "FONTCONFIG_FILE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMDRIVE",
    "PATHEXT",
    "COMSPEC",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name]!]],
    ),
  );
}
