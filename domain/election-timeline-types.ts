import type {AvailabilityChange, ImpactEvent} from './occupancy.ts';

type LoggedChoice={member_id:string;cycle_date:string};
export type ElectionTimelineItem={
 id:string;kind:'choice'|'defer'|'tie'|'legacy'|'joint';round:number|null;createdAt:string;
 memberIds:string[];choices:LoggedChoice[];deferredTurns:number;
 ties:{memberId:string;position:number;total:number;order:string[]}[];
 method?:'random'|'external';order?:string[];anticipated?:boolean;jointAction?:'register_joint'|'cancel_joint';
 impact?: {
  policyVersion:string; status:'exact'|'indeterminate'|'invalid';
  campaignVersionBefore:number; campaignVersionAfter:number;
  changes:AvailabilityChange[];events:ImpactEvent[];
 };
 warnings?:{code:string;message:string;period?:number}[];
};

