export type AppLayoutScrollPolicy = {
  isChatRoom: boolean;
  usesHeaderScrollOwner: boolean;
};

/**
 * PersistentTabs renders Discover for the app root. AppLayout must apply the
 * same route interpretation before choosing its scroll-owner policy.
 */
export function getAppLayoutScrollPolicy(location: string): AppLayoutScrollPolicy {
  const activePath = location === "/" ? "/discover" : location;
  const isChatRoom = activePath.startsWith("/messages/");

  return {
    isChatRoom,
    usesHeaderScrollOwner: !isChatRoom && (
      activePath.startsWith("/profile") || activePath.startsWith("/discover")
    ),
  };
}