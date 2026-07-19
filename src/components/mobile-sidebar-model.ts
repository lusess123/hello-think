export function getMobileSidebarAccessibility(
  open: boolean,
  isDesktop: boolean
) {
  const hidden = !isDesktop && !open;
  return {
    inert: hidden,
    ariaHidden: hidden ? true : undefined
  };
}
