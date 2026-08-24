import { IsNotEmpty, IsString } from 'class-validator';

// Shared by call:accept, call:reject and call:hangup -- all three only need
// to know which call they act on; the acting user comes from the
// authenticated socket, never from the payload.
export class CallActionDto {
  @IsString()
  @IsNotEmpty()
  callId: string;
}
