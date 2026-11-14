import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { applyPageGain } from '@/lib/page-gain';

export default defineUnlistedScript(() => {
  (window as Window & { __vgApply?: typeof applyPageGain }).__vgApply = applyPageGain;
});
