type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeAgyCliPermissions(
  settingsValue: unknown,
  requiredPermissions: readonly string[],
  obsoletePermissions: readonly string[] = [],
): { settings: JsonObject; changed: boolean } {
  if (!isJsonObject(settingsValue)) {
    throw new Error('Agy CLI settings must contain a JSON object');
  }
  if (requiredPermissions.some((permission) => !permission.trim())) {
    throw new Error('Agy CLI permissions must be non-empty strings');
  }

  const permissionsValue = settingsValue.permissions;
  if (permissionsValue !== undefined && !isJsonObject(permissionsValue)) {
    throw new Error('Agy CLI settings permissions must contain a JSON object');
  }
  const permissions = permissionsValue || {};
  const allowValue = permissions.allow;
  if (
    allowValue !== undefined
    && (!Array.isArray(allowValue) || allowValue.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error('Agy CLI settings permissions.allow must be an array of strings');
  }

  const existing = (allowValue || []) as string[];
  const retained = existing.filter((permission) => !obsoletePermissions.includes(permission));
  const missing = requiredPermissions.filter((permission) => !retained.includes(permission));
  if (missing.length === 0 && retained.length === existing.length) {
    return { settings: settingsValue, changed: false };
  }

  return {
    settings: {
      ...settingsValue,
      permissions: {
        ...permissions,
        allow: [...retained, ...missing],
      },
    },
    changed: true,
  };
}
