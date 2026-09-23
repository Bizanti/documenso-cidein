import type { TCssVarsSchema } from '@documenso/lib/types/css-vars';
import { isBrandingCssEnabled } from '@documenso/lib/utils/branding-entitlement';
import { useEffect } from 'react';

import { toNativeCssVarsString } from '~/utils/css-vars';

export type RecipientBrandingPayload = {
  allowCustomBranding: boolean;
  colors?: TCssVarsSchema | null;
  css?: string | null;
};

export type RecipientBrandingProps = {
  branding: RecipientBrandingPayload | null | undefined;
  cspNonce: string | undefined;
};

/**
 * Renders a `<style nonce>` block for a recipient route, scoped to the
 * `.documenso-branded` wrapper rendered in `_recipient+/_layout.tsx`.
 *
 * The brand colour variables (from `branding.colors`) are emitted as a nested
 * rule so the user doesn't need to scope their own selectors — native CSS
 * nesting handles it:
 *
 *   .documenso-branded {
 *     --background: ...;
 *   }
 *
 * Custom CSS (`branding.css`) is disabled for now — see `isBrandingCssEnabled` —
 * so a value stored by an older version is never injected, even though the
 * branding loader still returns it.
 *
 * Why both SSR `<style>` and a `useEffect` injection?
 *
 * The rendered `<style>` covers the initial server render so the first paint
 * already has the branding applied — without it, the page would flash the
 * default theme before hydration.
 *
 * The `useEffect` covers in-app client-side navigations. When the user
 * navigates between recipient routes via the router, the server render
 * doesn't run again, so React reconciles the existing DOM. If the loader
 * data changes (e.g. a different recipient with different branding), the
 * SSR'd `<style>` from the previous page may persist or be reused, leading
 * to stale or inconsistent branding. Appending a fresh `<style>` to
 * `document.head` and removing it on cleanup guarantees the active branding
 * matches the current route on both initial load and subsequent navigations.
 */
export const RecipientBranding = ({ branding, cspNonce }: RecipientBrandingProps) => {
  const varsString = toNativeCssVarsString(branding?.colors ?? {});

  // Nothing but the colour variables is ever injected while custom CSS is
  // disabled, even when a legacy row still carries a value.
  const userCss = isBrandingCssEnabled() ? (branding?.css ?? '') : '';

  const hasVars = varsString.trim().length > 0;
  const hasUserCss = userCss.trim().length > 0;

  const innerBody = `${hasVars ? `${varsString}\n` : ''}${hasUserCss ? userCss : ''}`.trim();
  const css = `.documenso-branded { ${innerBody} }`;

  useEffect(() => {
    if (!branding?.allowCustomBranding) {
      return;
    }

    if (!hasVars && !hasUserCss) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute('nonce', cspNonce ?? '');
    style.textContent = css;

    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, [branding, cspNonce, css, hasUserCss, hasVars]);

  if (!branding?.allowCustomBranding) {
    return null;
  }

  if (!hasVars && !hasUserCss) {
    return null;
  }

  return <style nonce={cspNonce}>{css}</style>;
};
