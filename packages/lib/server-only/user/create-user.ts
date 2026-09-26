import { prisma } from '@documenso/prisma';
import { hash } from '@node-rs/bcrypt';
import { Role, type User } from '@prisma/client';

import { SALT_ROUNDS } from '../../constants/auth';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { isRestrictedAccount } from '../auth/document-authorization';
import { createPersonalOrganisation } from '../organisation/create-organisation';

export interface CreateUserOptions {
  name: string;
  email: string;
  password: string;
  signature?: string | null;
}

export const createUser = async ({ name, email, password, signature }: CreateUserOptions) => {
  const hashedPassword = await hash(password, SALT_ROUNDS);

  const userExists = await prisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
    },
  });

  if (userExists) {
    throw new AppError(AppErrorCode.ALREADY_EXISTS);
  }

  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      password: hashedPassword, // Todo: (RR7) Drop password.
      signature,
      /**
       * A self service signup hands out the restricted profile: the account may
       * only sign the documents which are shared with it until an administrator
       * grants a wider profile.
       *
       * The role is passed explicitly instead of inheriting the `USER` default
       * of the schema, so the profile of a self service account is decided here
       * rather than by a database default.
       */
      roles: [Role.SIGN_ONLY],
    },
  });

  await onCreateUserHook(user).catch((err) => {
    // Todo: (RR7) Add logging.
    console.error(err);
  });

  return user;
};

export type OnCreateUserHookOptions = {
  /**
   * When true, do not create a "Personal Organisation" for the new user.
   * Used by the Organisation SSO signup path, where the user is intended
   * to operate inside the SSO organisation rather than a personal space.
   *
   * Defaults to false — preserves the historical behaviour of creating a
   * personal organisation for every new user.
   */
  skipPersonalOrganisation?: boolean;
};

/**
 * Which new accounts get a personal organisation, and with it a personal team.
 *
 * A restricted account signs the documents shared with it and owns no
 * workspace: giving it a personal organisation would both contradict the
 * restriction and leave every sign only signup with an organisation to
 * administer. Administrators and user profile accounts keep the historical
 * behaviour of receiving one.
 *
 * The check fails safe: roles which are not a valid combination are treated as
 * restricted, so inconsistent data never grants a personal space.
 */
const shouldCreatePersonalOrganisation = (user: Pick<User, 'roles'>, options: OnCreateUserHookOptions): boolean =>
  !options.skipPersonalOrganisation && !isRestrictedAccount(user);

/**
 * Should be run after a user is created, example during email password signup or google sign in.
 *
 * Only the id and the roles of the new account are read, which is also what
 * makes the decision testable without a full user record.
 *
 * @returns User
 */
export const onCreateUserHook = async (user: Pick<User, 'id' | 'roles'>, options: OnCreateUserHookOptions = {}) => {
  if (shouldCreatePersonalOrganisation(user, options)) {
    await createPersonalOrganisation({ userId: user.id });
  }

  return user;
};
