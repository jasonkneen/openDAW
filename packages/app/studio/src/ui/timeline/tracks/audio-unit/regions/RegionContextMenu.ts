import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {EmptyExec, Selection, Terminable} from "@opendaw/lib-std"
import {ContextMenu} from "@/ui/ContextMenu.ts"
import {MenuItem} from "@/ui/model/menu-item.ts"
import {AnyRegionBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {TimelineBox} from "@opendaw/studio-boxes"
import {Surface} from "@/ui/surface/Surface.tsx"
import {RegionTransformer} from "@/ui/timeline/tracks/audio-unit/regions/RegionTransformer.ts"
import {NameValidator} from "@/ui/validator/name.ts"
import {DebugMenus} from "@/ui/menu/debug"
import {exportNotesToMidiFile} from "@/ui/timeline/editors/notes/NoteUtils"
import {ColorMenu} from "@/ui/timeline/ColorMenu"
import {BPMTools} from "@opendaw/lib-dsp"
import {Browser} from "@opendaw/lib-dom"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {TimelineRange} from "@opendaw/studio-core"
import {AudioPlayback} from "@opendaw/studio-enums"
import {executeStemSplitting} from "@/service/stem-separation"

type Construct = {
    element: Element
    service: StudioService
    capturing: ElementCapturing<RegionCaptureTarget>
    selection: Selection<AnyRegionBoxAdapter>
    timelineBox: TimelineBox
    range: TimelineRange
}

export const installRegionContextMenu =
    ({element, service, capturing, selection, timelineBox, range}: Construct): Terminable => {
        const {project} = service
        const {editing, selection: vertexSelection} = project
        const computeSelectionRange = () => selection.selected().reduce((range, region) => {
            range[0] = Math.min(region.position, range[0])
            range[1] = Math.max(region.complete, range[1])
            return range
        }, [Number.MAX_VALUE, -Number.MAX_VALUE])
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const target = capturing.captureEvent(client)
            if (target === null || target.type === "track") {return}
            if (!selection.isSelected(target.region)) {
                selection.deselectAll()
                selection.select(target.region)
            }
            const region = target.region
            addItems(
                MenuItem.default({label: "Delete", shortcut: "⌫"})
                    .setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                        .forEach(adapter => adapter.box.delete()))),
                MenuItem.default({label: "Mute", checked: region.mute})
                    .setTriggerProcedure(() => editing.modify(() => {
                        const newValue = !region.mute
                        return selection.selected().slice().forEach(adapter => adapter.box.mute.setValue(newValue))
                    })),
                ColorMenu.createItem(hue => editing.modify(() =>
                    selection.selected().slice().forEach(adapter => adapter.box.hue.setValue(hue)))),
                MenuItem.default({label: "Rename"})
                    .setTriggerProcedure(() => Surface.get(element).requestFloatingTextInput(client, region.label).then(value => {
                        NameValidator.validate(value, {
                            success: name => editing.modify(() => selection.selected()
                                .forEach(adapter => adapter.box.label.setValue(name)))
                        })
                    }, EmptyExec)),
                MenuItem.default({label: "Loop Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        editing.modify(() => {
                            timelineBox.loopArea.from.setValue(min)
                            timelineBox.loopArea.to.setValue(max)
                        })
                    }),
                MenuItem.default({label: "Zoom Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        range.zoomRange(min, max)
                    }),
                MenuItem.default({
                    label: "Consolidate",
                    selectable: selection.selected().some(x => x.isMirrowed),
                    separatorBefore: true
                }).setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                    .forEach(adapter => adapter.consolidate()))),
                MenuItem.default({label: "Flatten", selectable: region.canFlatten(selection.selected())})
                    .setTriggerProcedure(() => editing.modify(() =>
                        region.flatten(selection.selected()).ifSome(box => project.selection.select(box)))),
                MenuItem.default({label: "Convert to Clip"})
                    .setTriggerProcedure(() => editing.modify(() => {
                        // TODO deselect all clips
                        service.timeline.clips.visible.setValue(true)
                        vertexSelection.select(RegionTransformer.toClip(region))
                    })),
                MenuItem.default({
                    label: "Export to Midi-File",
                    hidden: region.type !== "note-region"
                }).setTriggerProcedure(() => {
                    if (region.type === "note-region") {
                        const label = region.label
                        exportNotesToMidiFile(region.optCollection.unwrap(), `${label.length === 0 ? "region" : label}.mid`).then()
                    }
                }),
                MenuItem.default({
                    label: "Playback",
                    hidden: region.type !== "audio-region"
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({
                        label: "Pitch",
                        checked: region.type === "audio-region"
                            && region.box.playback.getValue() === AudioPlayback.Pitch
                    }).setTriggerProcedure(() => {
                        const adapters = selection.selected()
                            .filter((region): region is AudioRegionBoxAdapter =>
                                region.type === "audio-region" && region.playback !== AudioPlayback.Pitch)
                        if (adapters.length === 0) {return}
                        editing.modify(() => adapters.forEach(region => region.setPlayback(AudioPlayback.Pitch)))
                    }),
                    MenuItem.default({
                        label: "No Wrap",
                        checked: region.type === "audio-region"
                            && region.box.playback.getValue() === AudioPlayback.NoSync
                    }).setTriggerProcedure(() => {
                        const adapters = selection.selected()
                            .filter((region): region is AudioRegionBoxAdapter =>
                                region.type === "audio-region" && region.playback !== AudioPlayback.NoSync)
                        if (adapters.length === 0) {return}
                        editing.modify(() => adapters.forEach(region => region.setPlayback(AudioPlayback.NoSync)))
                    })
                )),
                MenuItem.default({
                    label: "Split Stems",
                    hidden: region.type !== "audio-region",
                    separatorBefore: true
                }).setTriggerProcedure(() => {
                    if (region.type === "audio-region") {
                        executeStemSplitting({
                            project,
                            region
                        }).catch(error => {
                            console.error("Stem splitting failed:", error)
                        })
                    }
                }),
                MenuItem.default({
                    label: "Calc Bpm",
                    hidden: region.type !== "audio-region" || !Browser.isLocalHost()
                }).setTriggerProcedure(() => {
                    if (region.type === "audio-region") {
                        region.file.data.ifSome(data => {
                            // TODO This is just for testing BPMTools
                            const bpm = BPMTools.detect(data.frames[0], data.sampleRate)
                            if (Browser.isLocalHost()) {
                                console.debug(bpm)
                            } else {
                                Dialogs.info({headline: "BPMTools", message: `${bpm.toFixed(3)} BPM`})
                                    .finally()
                            }
                        })
                    }
                }),
                DebugMenus.debugBox(region.box)
            )
        })
    }