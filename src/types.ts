type ReqHeaderFrame = {
  id: number;
  type: "req";
  m: string;
  p: string;
  q: string;
  h: Record<string, string>;
};
type ReqBodyFrame = {
  id: number;
  type: "req_body";
  b64: string;
  more: boolean;
};
type ResHeaderFrame = {
  id: number;
  type: "res";
  s: number;
  h: Record<string, string>;
};
type ResBodyFrame = {
  id: number;
  type: "res_body";
  b64: string;
  more: boolean;
};
type Frame = ReqHeaderFrame | ReqBodyFrame | ResHeaderFrame | ResBodyFrame;
