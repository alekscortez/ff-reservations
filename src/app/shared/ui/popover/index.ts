import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';
import { HlmPopoverContent } from './hlm-popover-content';

export { HlmPopoverContent } from './hlm-popover-content';
export {
  BrnPopover as HlmPopover,
  BrnPopoverContent as HlmPopoverContentHost,
  BrnPopoverTrigger as HlmPopoverTrigger,
} from '@spartan-ng/brain/popover';

export const HlmPopoverImports = [
  BrnPopover,
  BrnPopoverTrigger,
  BrnPopoverContent,
  HlmPopoverContent,
] as const;
