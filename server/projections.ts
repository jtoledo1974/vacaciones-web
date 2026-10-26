import type {Config} from '../domain/calendar.ts';
import type {Award,Member,Request,calculate} from '../domain/vacations.ts';
import type {ElectionService} from './election-service.ts';

/** Database rows have additional columns: the administrative projection preserves them. */
export type CampaignRow = {
    id:string;
    year:number;
    team_id:string;
    status:string;
    version:number;
    data_kind:string;
    scope_key:string;
    simulation_name:string | null;
    published_run_id:string | null;
    created_at:string;
};
export type CampaignMemberRow = Member & {
    person_id:string;
    campaign_id:string;
    label:string;
    position:number;
    version:number;
};
export type RunRow = {
    id:string;
    campaign_id:string;
    source_version:number;
    engine_version:string;
    result_json:string;
    created_by:string;
    created_at:string;
};
export type RequestRow = Request & {campaign_id:string;version:number};
export type AwardRow = Award & {campaign_id:string;version:number};
export type LoadedCampaign = {
    campaign:CampaignRow;
    config:Config;
    members:CampaignMemberRow[];
    requests:RequestRow[];
    awards:AwardRow[];
    runs:RunRow[];
};
export type ElectionView = Awaited<ReturnType<ElectionService['view']>>;
export type VacationResult = ReturnType<typeof calculate>;
export type PublicVacationResult = VacationResult & {ordering:[]};
export type PublicCampaignMember = Pick<CampaignMemberRow,'id'|'code'>;

export type PublicCampaignView = {
    campaign:Pick<CampaignRow,'id'|'year'|'team_id'|'status'|'version'|'data_kind'|'scope_key'|'simulation_name'>;
    members:PublicCampaignMember[];
    requests:[];
    awards:AwardRow[];
    result:PublicVacationResult;
    config:null;
    runs:[];
    election:ElectionView;
    participating:boolean;
    editable:false;
    preview:{code:string;writable:boolean} | undefined;
};

export type AdminCampaignView = Omit<LoadedCampaign,'runs'> & {
    runs:(Omit<RunRow,'result_json'> & {result_json:undefined})[];
    election:ElectionView;
    undo:{id:string;action:string} | null;
    redo:{id:string} | null;
    result:VacationResult;
    editable:true;
};

export type PublishedCampaignView = {
    campaign:Pick<CampaignRow,'id'|'year'|'team_id'> & {status:'published'};
    members:PublicCampaignMember[];
    awards:Award[];
    result:PublicVacationResult;
};

export type PublishedSnapshot = {
    members:PublicCampaignMember[];
    awards:Award[];
    result:VacationResult;
};

/** Keep the administrator's complete data, including future database columns. */
export function projectAdminCampaignView(
    data:LoadedCampaign,election:ElectionView,result:VacationResult,
    entry:{id:string;action:string} | null
):AdminCampaignView {
    return {
        ...data,
        election,
        undo:entry&&entry.action!=='undo_vacations'?{id:entry.id,action:entry.action}:null,
        redo:entry?.action==='undo_vacations'?{id:entry.id}:null,
        result,
        runs:data.runs.map(r=>({...r,result_json:undefined})),
        editable:true
    };
}

/** Only explicitly selected campaign and controller fields cross the public boundary. */
export function projectPublicCampaignView(
    data:LoadedCampaign,cid:string,election:ElectionView,result:VacationResult,
    preview:{campaignId:string;code:string;writable:boolean} | undefined
):PublicCampaignView {
    return {
        campaign:{id:cid,year:data.campaign.year,team_id:data.campaign.team_id,status:data.campaign.status,
            version:data.campaign.version,data_kind:data.campaign.data_kind,scope_key:data.campaign.scope_key,
            simulation_name:data.campaign.simulation_name},
        members:data.members.map(m=>({id:m.id,code:m.code})),
        requests:[],
        awards:data.awards,
        result:{...result,ordering:[] as []},
        config:null,
        runs:[],
        election,
        participating:!!election.myMemberId,
        editable:false,
        preview:preview&&preview.campaignId===cid?{code:preview.code,writable:preview.writable}:undefined
    };
}

/** The published snapshot intentionally omits ordering and all private member columns. */
export function projectPublishedCampaignView(
    data:LoadedCampaign,cid:string,snapshot:PublishedSnapshot
):PublishedCampaignView {
    return {
        campaign:{id:cid,year:data.campaign.year,team_id:data.campaign.team_id,status:'published'},
        members:snapshot.members.map(m=>({id:m.id,code:m.code})),
        awards:snapshot.awards,
        result:{...snapshot.result,ordering:[] as []}
    };
}
