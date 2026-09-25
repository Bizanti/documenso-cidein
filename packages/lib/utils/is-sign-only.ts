import type { User } from '@prisma/client';
import { Role } from '@prisma/client';

/**
 * Whether the user is restricted to only signing documents which have been
 * shared with them.
 *
 * The check is fail-safe: when the sign only role appears alongside any other
 * role, the restriction wins.
 */
export const isSignOnly = (user: Pick<User, 'roles'>) => user.roles.includes(Role.SIGN_ONLY);
