import {RootBox} from "./RootBox"
import {SelectionBox} from "./SelectionBox"
import {UserInterfaceBox} from "./UserInterface"
import {UploadFileBox} from "./UploadFileBox"
import {TimelineBox} from "./timeline/TimelineBox"
import {TrackBox} from "./timeline/TrackBox"
import {NoteClipBox} from "./timeline/NoteClipBox"
import {ValueClipBox} from "./timeline/ValueClipBox"
import {MarkerBox} from "./timeline/MarkerBox"
import {AudioFileBox} from "./AudioFileBox"
import {SoundfontFileBox} from "./SoundfontFileBox"
import {AudioBusBox, AudioUnitBox, AuxSendBox} from "./AudioUnitBox"
import {CaptureAudioBox, CaptureMidiBox} from "./CaptureBox"
import {GrooveShuffleBox} from "./GrooveBoxes"
import {AudioRegionBox} from "./timeline/AudioRegionBox"
import {AudioClipBox} from "./timeline/AudioClipBox"
import {NoteEventBox} from "./timeline/NoteEventBox"
import {NoteEventRepeatBox} from "./timeline/NoteEventRepeatBox"
import {NoteEventCollectionBox} from "./timeline/NoteEventCollectionBox"
import {NoteRegionBox} from "./timeline/NoteRegionBox"
import {ValueEventBox} from "./timeline/ValueEventBox"
import {ValueEventCurveBox} from "./timeline/ValueEventCurveBox"
import {ValueEventCollectionBox} from "./timeline/ValueEventCollectionBox"
import {ValueRegionBox} from "./timeline/ValueRegionBox"
import {StemSeparationJobBox, StemSeparationOutputBox} from "./StemSeparationBox"

export const Definitions = [
    RootBox, SelectionBox, UserInterfaceBox, UploadFileBox,
    TimelineBox, TrackBox,
    NoteEventBox, NoteEventRepeatBox, NoteEventCollectionBox, NoteRegionBox, NoteClipBox,
    ValueEventBox, ValueEventCollectionBox, ValueEventCurveBox, ValueRegionBox, ValueClipBox,
    AudioRegionBox, AudioClipBox,
    MarkerBox,
    AudioFileBox, SoundfontFileBox,
    AudioUnitBox, CaptureAudioBox, CaptureMidiBox,
    AudioBusBox, AuxSendBox,
    GrooveShuffleBox,
    StemSeparationJobBox, StemSeparationOutputBox
]