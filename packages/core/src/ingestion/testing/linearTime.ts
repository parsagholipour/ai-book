/**
 * The ceiling every "reads … in linear time" test in the upload parsers holds a
 * run to. Each case's larger size took 1.1–14 s on the quadratic code it pins,
 * and takes a few milliseconds alone on the linear one, so the ceiling sits
 * between with room for a loaded machine: at 200 ms the cases flaked while the
 * whole `pnpm check` ran its workspaces side by side.
 */
export const LINEAR_TIME_CEILING_MS = 600;
