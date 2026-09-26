import { cn } from '@documenso/ui/lib/utils';
import { Button } from '@documenso/ui/primitives/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@documenso/ui/primitives/command';
import { Popover, PopoverContent, PopoverTrigger } from '@documenso/ui/primitives/popover';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Role } from '@prisma/client';
import { Check, ChevronsUpDown } from 'lucide-react';
import * as React from 'react';

type RoleProfileSelectProps = {
  roles: string[];
  onChange: (_roles: string[]) => void;
};

/**
 * The role combinations which describe a user profile.
 *
 * Roles are only ever stored in these combinations, so the form edits the profile as a whole
 * instead of individual roles and can never submit a combination the server will reject.
 */
const ROLE_PROFILES: { key: string; label: MessageDescriptor; roles: Role[] }[] = [
  { key: 'SIGN_ONLY', label: msg`Sign only`, roles: [Role.SIGN_ONLY] },
  { key: 'USER', label: msg`User`, roles: [Role.USER] },
  { key: 'ADMIN', label: msg`Admin`, roles: [Role.USER, Role.ADMIN] },
];

/**
 * Find the profile matching a stored role list.
 *
 * The sign only restriction wins over anything else, which keeps an inconsistent list
 * readable instead of leaving the select empty.
 */
const getProfileKey = (roles: string[]) => {
  if (roles.includes(Role.SIGN_ONLY)) {
    return 'SIGN_ONLY';
  }

  if (roles.includes(Role.ADMIN)) {
    return 'ADMIN';
  }

  return 'USER';
};

const RoleProfileSelect = ({ roles, onChange }: RoleProfileSelectProps) => {
  const { _ } = useLingui();

  const [open, setOpen] = React.useState(false);

  const profileKey = getProfileKey(roles);
  const selectedProfile = ROLE_PROFILES.find((profile) => profile.key === profileKey) ?? ROLE_PROFILES[0];

  const handleSelect = (key: string) => {
    const profile = ROLE_PROFILES.find((roleProfile) => roleProfile.key === key);

    if (profile) {
      onChange([...profile.roles]);
    }

    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-[200px] justify-between">
          {_(selectedProfile.label)}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command>
          <CommandInput placeholder={_(selectedProfile.label)} />
          <CommandEmpty>
            <Trans>No value found.</Trans>
          </CommandEmpty>
          <CommandGroup>
            {ROLE_PROFILES.map((profile) => (
              <CommandItem key={profile.key} onSelect={() => handleSelect(profile.key)}>
                <Check
                  className={cn('mr-2 h-4 w-4', profile.key === selectedProfile.key ? 'opacity-100' : 'opacity-0')}
                />
                {_(profile.label)}
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export { RoleProfileSelect };
