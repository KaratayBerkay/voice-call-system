import { IsNotEmpty, IsString } from 'class-validator';

export class CallInviteDto {
  @IsString()
  @IsNotEmpty()
  calleeId: string;
}
