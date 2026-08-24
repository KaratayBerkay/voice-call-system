import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class SdpDto {
  @IsString()
  @IsNotEmpty()
  sdp: string;

  @IsIn(['offer', 'answer'])
  type: string;
}

export class WebrtcSignalDto {
  @IsString()
  @IsNotEmpty()
  callId: string;

  @IsObject()
  sdp: SdpDto;
}

export class IceCandidateData {
  @IsString()
  @IsNotEmpty()
  candidate: string;

  @IsOptional()
  @IsString()
  sdpMid?: string | null;

  @IsOptional()
  @IsInt()
  sdpMLineIndex?: number | null;
}

export class IceCandidateDto {
  @IsString()
  @IsNotEmpty()
  callId: string;

  @IsObject()
  candidate: IceCandidateData;
}
