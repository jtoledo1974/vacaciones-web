import type {Config} from './calendar.ts';

/**
 * The convention and HR-grace pools are configured independently.
 *
 * Pooling convention does not pool period-specific grace: an allowance
 * reserved for October cannot be spent in January unless commonGrace=true.
 * Test feasibility by assigning each period its own allowance first, then
 * drawing the deficit from whichever pool is explicitly shared.
 */
export function winterExtraExceeded(
 config:Pick<Config,'commonConvention'|'commonGrace'|'grace'>,
 conventionWinter:number,
 convention:number[],
 extra:number[]
):boolean{
 const january=extra[0],october=extra[2];
 const graceJanuary=config.grace[0],graceOctober=config.grace[2];
 if(config.commonConvention&&config.commonGrace)
  return january+october>conventionWinter+graceJanuary+graceOctober;
 if(config.commonConvention)
  return Math.max(0,january-graceJanuary)+Math.max(0,october-graceOctober)>conventionWinter;
 if(config.commonGrace)
  return Math.max(0,january-convention[0])+Math.max(0,october-convention[2])>graceJanuary+graceOctober;
 return january>convention[0]+graceJanuary||october>convention[2]+graceOctober;
}
