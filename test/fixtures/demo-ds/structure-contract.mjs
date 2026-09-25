// Tidepool, a fictional design system: how each Figma component is realised in code.
export const COMPONENT_CSS_SELECTORS = {
  button: { main: '.tp-button' },
  chip: { main: '.tp-chip' },
  field: { main: '.tp-field' },
};

export const CONTRACT = {
  button: {
    h: 32, paddingVar: { tb: 'padding/xs', lr: 'padding/m' }, gapVar: 'gap/s', innerRadiusVar: 'radii/button',
    fontSizeVar: 'm', fontWeightVar: 'm', strokeOnDefault: false,
    propertyMap: {
      State: { Default: '.tp-button', Hover: '.tp-button:hover' },
      Disabled: { False: '.tp-button', True: '.tp-button:disabled' },
    },
  },
  chip: {
    h: 24, paddingVar: { tb: 'padding/xs', lr: 'padding/s' }, gapVar: 'gap/s', innerRadiusVar: 'radii/chip',
    fontSizeVar: 's', fontWeightVar: 's', strokeOnDefault: false,
    propertyMap: {
      Size: { M: '.tp-chip', L: '.tp-chip.tp-chip--l' },
      Icon: { False: '.tp-chip', True: '.tp-chip.tp-chip--icon' },
    },
    children: [
      { name: 'Icon', cssSelector: '.tp-chip .tp-chip__icon' },
      { name: 'Label', cssSelector: '.tp-chip .tp-chip__label' },
    ],
  },
  field: {
    h: 36, paddingVar: { tb: 'padding/s', lr: 'padding/s' }, innerRadiusVar: 'radii/field', fontSizeVar: 'm', strokeOnDefault: true, strokeSides: 'all',
    propertyMap: {
      State: { Default: '.tp-field', Error: '.tp-field.tp-field--error' },
    },
  },
};
