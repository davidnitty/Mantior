import { AuditLogger } from '../audit/logger';

export type EnvironmentName = 'development' | 'staging' | 'production';

export interface PermissionScope {
  /** What can be accessed */
  resources: string[];
  /** What actions can be performed */
  actions: string[];
  /** What data can be modified */
  dataTypes: string[];
  /** Time-based restrictions */
  timeRestriction?: {
    start: string; // e.g., "09:00"
    end: string; // e.g., "17:00"
    timezone: string;
  };
  /** Environment restrictions */
  environments: EnvironmentName[];
}

export interface Permission {
  id: string;
  name: string;
  description: string;
  scope: PermissionScope;
  grantedTo: string;
  grantedAt: Date;
  expiresAt?: Date;
}

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
  requiredPermissions?: string[];
  missingPermissions?: string[];
}

/**
 * Least-privilege enforcement: every action is checked against granted
 * permission scopes (resource × action × dataType × environment × time).
 */
export class PermissionManager {
  private readonly permissions = new Map<string, Permission>();
  private readonly audit: AuditLogger;

  constructor(audit = new AuditLogger()) {
    this.audit = audit;
    this.loadDefaultPermissions();
  }

  /**
   * Check if an action is allowed for a user.
   */
  check(
    userId: string,
    action: string,
    resource: string,
    environment: string,
    dataType?: string,
  ): PermissionCheck {
    const userPermissions = this.getUserPermissions(userId);

    for (const permission of userPermissions) {
      if (!matches(permission.scope.actions, action)) {
        continue;
      }
      if (!matches(permission.scope.resources, resource)) {
        continue;
      }
      if (dataType && !matches(permission.scope.dataTypes, dataType)) {
        continue;
      }

      const environments = permission.scope.environments as readonly string[];
      if (!environments.includes(environment)) {
        continue;
      }

      if (permission.scope.timeRestriction) {
        const now = new Date();
        const currentTime = now.toTimeString().slice(0, 5);
        const { start, end } = permission.scope.timeRestriction;
        if (currentTime < start || currentTime > end) {
          return {
            allowed: false,
            reason: `Action outside allowed time window (${start}-${end})`,
            missingPermissions: [],
          };
        }
      }

      if (permission.expiresAt && new Date() > permission.expiresAt) {
        continue;
      }

      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `User ${userId} lacks permission for ${action} on ${resource}`,
      missingPermissions: [`${action}:${resource}`],
    };
  }

  /**
   * Get all permissions granted to a user (including wildcard '*' grants).
   */
  getUserPermissions(userId: string): Permission[] {
    const result: Permission[] = [];
    for (const permission of this.permissions.values()) {
      if (permission.grantedTo === userId || permission.grantedTo === '*') {
        result.push(permission);
      }
    }
    return result;
  }

  /**
   * Grant a permission.
   */
  grant(permission: Omit<Permission, 'id' | 'grantedAt'>): string {
    const id = `perm_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const fullPermission: Permission = {
      ...permission,
      id,
      grantedAt: new Date(),
    };

    this.permissions.set(id, fullPermission);

    this.audit.logAction({
      action: 'permission_granted',
      userId: permission.grantedTo,
      metadata: {
        permissionId: id,
        name: permission.name,
        scope: permission.scope,
      },
    });

    return id;
  }

  /**
   * Revoke a permission.
   */
  revoke(permissionId: string): void {
    const permission = this.permissions.get(permissionId);
    if (!permission) {
      throw new Error(`Permission not found: ${permissionId}`);
    }

    this.permissions.delete(permissionId);

    this.audit.logAction({
      action: 'permission_revoked',
      userId: permission.grantedTo,
      metadata: {
        permissionId,
        name: permission.name,
      },
    });
  }

  /**
   * List all permissions.
   */
  list(): Permission[] {
    return Array.from(this.permissions.values());
  }

  private loadDefaultPermissions(): void {
    // Developer permissions (read-only)
    this.grant({
      name: 'Developer Read-Only',
      description: 'Read access to all resources',
      scope: {
        resources: ['*'],
        actions: ['read', 'list', 'view'],
        dataTypes: ['*'],
        environments: ['development', 'staging'],
      },
      grantedTo: 'developer',
    });

    // Operator permissions (restricted write)
    this.grant({
      name: 'Operator Write',
      description: 'Write access to non-critical resources',
      scope: {
        resources: ['workers', 'caches', 'queues'],
        actions: ['read', 'write', 'update', 'restart'],
        dataTypes: ['config', 'logs', 'metrics'],
        environments: ['development', 'staging'],
      },
      grantedTo: 'operator',
    });

    // Admin permissions (full access)
    this.grant({
      name: 'Admin Full Access',
      description: 'Full access to all resources',
      scope: {
        resources: ['*'],
        actions: ['*'],
        dataTypes: ['*'],
        environments: ['development', 'staging', 'production'],
        timeRestriction: {
          start: '00:00',
          end: '23:59',
          timezone: 'UTC',
        },
      },
      grantedTo: 'admin',
    });

    // System permissions (automated)
    this.grant({
      name: 'System Automated',
      description: 'Limited automated actions',
      scope: {
        resources: ['workers', 'caches'],
        actions: ['read', 'restart'],
        dataTypes: ['logs', 'metrics'],
        environments: ['development', 'staging'],
      },
      grantedTo: 'system',
    });

    // Critical permissions (production database)
    this.grant({
      name: 'Database Admin',
      description: 'Database schema changes require approval',
      scope: {
        resources: ['database'],
        actions: ['schema_change', 'migration'],
        dataTypes: ['schema'],
        environments: ['production'],
      },
      grantedTo: 'db_admin',
    });
  }
}

/** Scope matching: a '*' entry grants access to any value in that dimension. */
function matches(scopeList: string[], value: string): boolean {
  return scopeList.includes('*') || scopeList.includes(value);
}

export const permissionManager = new PermissionManager();
