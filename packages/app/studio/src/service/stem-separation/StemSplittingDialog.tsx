import css from "./StemSplittingDialog.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Dialog} from "@/ui/components/Dialog"
import {IconSymbol, Colors} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface"
import {DefaultObservableValue, Errors, Lifecycle, Terminator} from "@opendaw/lib-std"
import {ProgressBar} from "@/ui/components/ProgressBar"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {Html} from "@opendaw/lib-dom"
import {
    getStemLabel,
    getStemTypesForModel,
    StemModel,
    StemType
} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "StemSplittingDialog")

export interface StemSplittingConfig {
    model: StemModel
    selectedStems: Set<StemType>
    createTracks: boolean
}

interface StemSplittingDialogResult {
    config: StemSplittingConfig
}

export const showStemSplittingDialog = async (
    audioFileName: string
): Promise<StemSplittingDialogResult> => {
    const {resolve, reject, promise} = Promise.withResolvers<StemSplittingDialogResult>()
    const lifecycle = new Terminator()

    // Configuration state
    const model = new DefaultObservableValue<StemModel>(StemModel.FourStem)
    const selectedStems = new DefaultObservableValue<Set<StemType>>(
        new Set(getStemTypesForModel(StemModel.FourStem))
    )
    const createTracks = new DefaultObservableValue<boolean>(true)

    // Update selected stems when model changes
    lifecycle.own(model.subscribe(owner => {
        selectedStems.setValue(new Set(getStemTypesForModel(owner.getValue())))
    }))

    const dialog: HTMLDialogElement = (
        <Dialog
            headline="Split Stems"
            icon={IconSymbol.Waveform}
            cancelable={true}
            style={{minWidth: "400px"}}
            buttons={[
                {
                    text: "Cancel",
                    onClick: handler => {
                        handler.close()
                        reject(Errors.AbortError)
                    }
                },
                {
                    text: "Split",
                    primary: true,
                    onClick: handler => {
                        handler.close()
                        resolve({
                            config: {
                                model: model.getValue(),
                                selectedStems: selectedStems.getValue(),
                                createTracks: createTracks.getValue()
                            }
                        })
                    }
                }
            ]}
        >
            <div className={className}>
                <div className="info">
                    <p>Split <strong>{audioFileName}</strong> into separate stems using AI-powered source separation.</p>
                </div>

                <div className="section">
                    <h3>Separation Model</h3>
                    <ModelSelector lifecycle={lifecycle} model={model} />
                </div>

                <div className="section">
                    <h3>Stems to Extract</h3>
                    <StemSelector
                        lifecycle={lifecycle}
                        model={model}
                        selectedStems={selectedStems}
                    />
                </div>

                <div className="section">
                    <h3>Options</h3>
                    <Checkbox
                        lifecycle={lifecycle}
                        model={createTracks}
                        appearance={{activeColor: Colors.blue, cursor: "pointer"}}
                    >
                        <span>Create new tracks for each stem</span>
                        <Icon symbol={IconSymbol.Checkbox} />
                    </Checkbox>
                </div>
            </div>
        </Dialog>
    )

    dialog.oncancel = () => reject(Errors.AbortError)
    Surface.get().flyout.appendChild(dialog)
    dialog.showModal()

    return promise.finally(() => lifecycle.terminate())
}

interface ModelSelectorProps {
    lifecycle: Lifecycle
    model: DefaultObservableValue<StemModel>
}

const ModelSelector = ({lifecycle, model}: ModelSelectorProps) => {
    const models = [
        {value: StemModel.TwoStem, label: "2 Stems", description: "Vocals + Accompaniment"},
        {value: StemModel.FourStem, label: "4 Stems", description: "Vocals, Drums, Bass, Other"},
        {value: StemModel.FiveStem, label: "5 Stems", description: "Vocals, Drums, Bass, Piano, Other"}
    ]

    const container: HTMLElement = <div className="model-selector" />

    const updateSelection = () => {
        const currentModel = model.getValue()
        container.querySelectorAll(".model-option").forEach((el, index) => {
            el.classList.toggle("selected", models[index].value === currentModel)
        })
    }

    models.forEach(({value, label, description}) => {
        const option: HTMLElement = (
            <div className="model-option" onclick={() => model.setValue(value)}>
                <div className="label">{label}</div>
                <div className="description">{description}</div>
            </div>
        )
        container.appendChild(option)
    })

    lifecycle.own(model.subscribe(updateSelection))
    updateSelection()

    return container
}

interface StemSelectorProps {
    lifecycle: Lifecycle
    model: DefaultObservableValue<StemModel>
    selectedStems: DefaultObservableValue<Set<StemType>>
}

const StemSelector = ({lifecycle, model, selectedStems}: StemSelectorProps) => {
    const container: HTMLElement = <div className="stem-selector" />

    const rebuildStems = () => {
        container.innerHTML = ""
        const stemTypes = getStemTypesForModel(model.getValue())
        const currentSelection = selectedStems.getValue()

        stemTypes.forEach(stemType => {
            const isSelected = new DefaultObservableValue(currentSelection.has(stemType))

            lifecycle.own(isSelected.subscribe(owner => {
                const newSelection = new Set(selectedStems.getValue())
                if (owner.getValue()) {
                    newSelection.add(stemType)
                } else {
                    newSelection.delete(stemType)
                }
                selectedStems.setValue(newSelection)
            }))

            const stemOption: HTMLElement = (
                <Checkbox
                    lifecycle={lifecycle}
                    model={isSelected}
                    appearance={{activeColor: getStemColor(stemType), cursor: "pointer"}}
                >
                    <span>{getStemLabel(stemType)}</span>
                    <Icon symbol={IconSymbol.Checkbox} />
                </Checkbox>
            )
            container.appendChild(stemOption)
        })
    }

    lifecycle.own(model.subscribe(rebuildStems))
    rebuildStems()

    return container
}

function getStemColor(stemType: StemType) {
    switch (stemType) {
        case "vocals": return Colors.blue
        case "drums": return Colors.orange
        case "bass": return Colors.green
        case "piano": return Colors.purple
        case "other": return Colors.gray
        case "accompaniment": return Colors.blue // Use blue for accompaniment
        default: return Colors.cream
    }
}

export interface StemSplittingProgressProps {
    lifecycle: Lifecycle
    progress: DefaultObservableValue<number>
    message: DefaultObservableValue<string>
}

export const showStemSplittingProgress = async (
    onCancel?: () => void
): Promise<{
    update: (progress: number, message: string) => void
    complete: () => void
    fail: (error: string) => void
}> => {
    const lifecycle = new Terminator()
    const progress = new DefaultObservableValue<number>(0)
    const message = new DefaultObservableValue<string>("Initializing...")
    let isCancelled = false

    const dialog: HTMLDialogElement = (
        <Dialog
            headline="Splitting Stems"
            icon={IconSymbol.Waveform}
            cancelable={true}
            style={{minWidth: "350px"}}
            buttons={[
                {
                    text: "Cancel",
                    onClick: handler => {
                        isCancelled = true
                        onCancel?.()
                        handler.close()
                    }
                }
            ]}
        >
            <div className={className}>
                <div className="progress-section">
                    <ProgressBar lifecycle={lifecycle} progress={progress} />
                    <p className="message">{message.getValue()}</p>
                </div>
            </div>
        </Dialog>
    )

    // Update message display when it changes
    const messageEl = dialog.querySelector(".message") as HTMLElement
    lifecycle.own(message.subscribe(owner => {
        if (messageEl) {
            messageEl.textContent = owner.getValue()
        }
    }))

    dialog.oncancel = () => {
        isCancelled = true
        onCancel?.()
    }

    Surface.get().flyout.appendChild(dialog)
    dialog.showModal()

    return {
        update: (prog: number, msg: string) => {
            if (!isCancelled) {
                progress.setValue(prog)
                message.setValue(msg)
            }
        },
        complete: () => {
            lifecycle.terminate()
            dialog.close()
        },
        fail: (error: string) => {
            message.setValue(`Error: ${error}`)
            // Keep dialog open for a moment to show error
            setTimeout(() => {
                lifecycle.terminate()
                dialog.close()
            }, 3000)
        }
    }
}
